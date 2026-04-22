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
  files.forEach(f => console.log('  â€¢', f));
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
    console.log('done âœ“');
  }

  // Create vector store
  console.log('\nCreating vector store...');
  const vectorStore = await openai.vectorStores.create({
    name: 'EX3 SAP SuccessFactors Recruiting Knowledge Base',
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
  console.log(`\r  All ${files.length} files processed âœ“\n`);

  // Create assistant
  console.log('Creating assistant...');
  const assistant = await openai.beta.assistants.create({
    name: ‘EX3 RCM AI Test Analyst’,
    instructions: `You are an expert SAP SuccessFactors RCM (Recruiting Management) test analyst embedded in the EX3 AI Test Hub. You specialise in end-to-end test scripts for SuccessFactors Recruiting implementations.

You have access to detailed SAP SuccessFactors Recruiting documentation. Use it to answer test-related questions accurately and specifically.

Your primary expertise:
- Analysing and explaining RCM test steps (system login, position creation, requisition management, job posting, candidate application, interview scheduling, offer management, hiring/onboarding)
- Identifying root causes of test failures in SAP SuccessFactors Recruiting
- Generating new test cases and edge case scenarios
- Finding coverage gaps in test scripts
- Explaining expected vs actual behaviour for any RCM process
- Advising on test data setup and proxy/impersonation for multi-role testing
- Suggesting fixes for configuration issues found during testing

Rules:
- Keep answers focused and actionable: 3-6 sentences unless generating test steps
- Always include exact SAP SuccessFactors navigation paths (e.g. Module Picker > Recruiting > Job Requisitions)
- When generating test steps, use this format: Step N | Action | Input/Test Data | Expected Result
- Reference specific scenario IDs (e.g. RCM-RC-104) when relevant
- If asked to generate test cases, produce at least 5 numbered steps
- If a question is not about SAP SuccessFactors testing or RCM, politely redirect`,
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

  console.log('\nâœ“ Setup complete! IDs saved to .env');
  console.log('\nYou can now start the server:');
  console.log('  node server.js\n');
}

setup().catch(err => {
  console.error('\nSetup failed:', err.message);
  process.exit(1);
});

