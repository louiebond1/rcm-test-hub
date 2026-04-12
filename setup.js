require('dotenv').config();
const OpenAI = require('openai');
const fs = require('fs');
const path = require('path');

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function setup() {
  const docsDir = path.join(__dirname, 'docs');
  const supported = ['.docx', '.pdf', '.txt', '.md'];
  const files = fs.readdirSync(docsDir).filter(f =>
    supported.includes(path.extname(f).toLowerCase())
  );

  if (files.length === 0) {
    console.error('No documents found in the docs/ folder. Add your .docx files and try again.');
    process.exit(1);
  }

  console.log(`Found ${files.length} document(s) to upload:\n`);
  files.forEach(f => console.log('  •', f));
  console.log('');

  // Upload files
  const fileIds = [];
  for (const file of files) {
    process.stdout.write(`Uploading "${file}"... `);
    const filePath = path.join(docsDir, file);
    const uploaded = await openai.files.create({
      file: fs.createReadStream(filePath),
      purpose: 'assistants',
    });
    fileIds.push(uploaded.id);
    console.log('done ✓');
  }

  // Create vector store
  console.log('\nCreating vector store...');
  const vectorStore = await openai.vectorStores.create({
    name: 'EX3 SmartRecruiters Knowledge Base',
    file_ids: fileIds,
  });
  console.log(`Vector store created: ${vectorStore.id}`);

  // Wait for all files to process
  console.log('Processing files (this may take a minute)...');
  let store = vectorStore;
  while (store.file_counts.in_progress > 0) {
    await new Promise(r => setTimeout(r, 2000));
    store = await openai.vectorStores.retrieve(vectorStore.id);
    process.stdout.write(`\r  ${store.file_counts.completed}/${files.length} processed...`);
  }
  console.log(`\r  All ${files.length} files processed ✓\n`);

  // Create assistant
  console.log('Creating assistant...');
  const assistant = await openai.beta.assistants.create({
    name: 'EX3 SmartRecruiters Guide',
    instructions: `You are EX3, a helpful AI assistant embedded in the EX3 SmartRecruiters Enablement Guide — an internal training tool for Recruiters, Hiring Managers, Candidates, and Administrators.

You have access to detailed SmartRecruiters documentation. Use it to answer questions accurately and specifically.

Rules:
- Keep answers concise: 2–5 sentences unless the question genuinely needs more detail
- Always include the navigation path in SmartRecruiters where relevant (e.g. "Settings → Configuration → Hiring Process")
- Be practical — tell the user exactly what to click or where to go
- If the documents contain a step-by-step guide for the task, summarise the key steps and mention the guide exists in the tool
- If a question is not about SmartRecruiters, politely decline and redirect to SmartRecruiters topics`,
    model: 'gpt-4o-mini',
    tools: [{ type: 'file_search' }],
    tool_resources: {
      file_search: {
        vector_store_ids: [vectorStore.id],
      },
    },
  });
  console.log(`Assistant created: ${assistant.id}`);

  // Append IDs to .env
  const envPath = path.join(__dirname, '.env');
  let envContent = fs.readFileSync(envPath, 'utf8').trimEnd();
  envContent += `\nASSISTANT_ID=${assistant.id}\nVECTOR_STORE_ID=${vectorStore.id}\n`;
  fs.writeFileSync(envPath, envContent);

  console.log('\n✓ Setup complete! IDs saved to .env');
  console.log('\nYou can now start the server:');
  console.log('  node server.js\n');
}

setup().catch(err => {
  console.error('\nSetup failed:', err.message);
  process.exit(1);
});
