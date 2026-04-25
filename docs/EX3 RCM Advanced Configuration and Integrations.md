# EX3 SAP SuccessFactors RCM — Advanced Configuration & Integrations

---

## SECTION 1: APPROVAL WORKFLOW CONFIGURATION

### Overview
Approval workflows in RCM control who must approve a Job Requisition or Offer before it can proceed. SAP SuccessFactors supports multi-step, conditional, and role-based approval chains.

**Navigation:** Admin Center → Recruiting → Manage Approval Workflows

### Types of Approval Workflows
| Type | Used For |
|------|----------|
| Requisition Approval | Approving a job requisition before it can be posted |
| Offer Approval | Approving an offer before it can be extended to a candidate |

### How to Create a Requisition Approval Workflow

1. Admin Center → Recruiting → **Manage Approval Workflows**
2. Click **Create New Workflow**
3. Enter Workflow Name (e.g. "Standard Requisition Approval")
4. Select Type: **Job Requisition**
5. Add approval steps — each step is one approver or group:
   - Click **Add Step**
   - Select approver type: **Specific User**, **Role in Requisition** (e.g. Hiring Manager's Manager), **HR Business Partner**, or **Dynamic Group**
   - Set step order (Step 1 → Step 2 → Step 3)
6. Configure step behaviour:
   - **All must approve** — every person in the step must approve before moving to next
   - **Any one can approve** — first approval from the group moves the workflow forward
7. Click **Save**

### How to Create a Multi-Step Approval Chain (Example)
A typical RCM requisition approval chain:
- Step 1: Hiring Manager approves the need to hire
- Step 2: HR Business Partner reviews and approves job details
- Step 3: Finance / Cost Centre approver signs off on budget
- Step 4: Recruiter does final check before posting

Each step is added sequentially. The requisition cannot proceed to the next step until the current step is fully approved.

### Conditional Routing
Conditional routing sends the requisition to different approvers based on field values.

**Example conditions:**
- If Salary > £60,000 → route to Finance Director for additional approval
- If Location = International → route to Global HR for compliance check
- If Employment Type = Contract → route to Legal for contract review

**How to set up conditional routing:**
1. In the Approval Workflow builder → click **Add Condition** on a step
2. Select the field to evaluate (e.g. Salary, Location, Employment Type)
3. Set the condition (e.g. greater than, equals, contains)
4. Set the value threshold
5. Define the routing: **Include this step** or **Skip this step** based on whether the condition is met
6. Save

### Escalation and Delegation

**Escalation — what happens if an approver does not respond:**
1. Admin Center → Recruiting → Manage Approval Workflows → open workflow
2. Click the relevant step → **Escalation Settings**
3. Set escalation period (e.g. escalate after 3 business days)
4. Set escalation target: manager of the approver, or a specific backup user
5. Save

**Delegation — approver sets an out-of-office delegate:**
1. Approver navigates to their Profile → **Proxy Management** (or Admin Center → Manage Proxies)
2. Adds a delegate for a specified date range
3. During the delegation period, all approval tasks are sent to the delegate instead

**Admin override — manually reassigning a stuck approval:**
1. Admin Center → Recruiting → open the requisition
2. Click **Manage Approval** or **Approval History**
3. Select the stuck step → **Reassign Approver**
4. Choose the new approver → Save
5. Notification sent to new approver

### How to Assign a Workflow to a Requisition Template
1. Admin Center → Recruiting → **Job Requisition Templates**
2. Open the relevant template (e.g. Standard Job Requisition)
3. Scroll to **Approval Workflow** section
4. Select the workflow from the dropdown
5. Save — all requisitions created from this template will use this workflow

### Adhoc Approvers
Recruiters can add one-off approvers to a specific requisition without changing the global workflow:
1. Open the Job Requisition → scroll to Approval section
2. Click **Add Adhoc Approver**
3. Search and select user
4. Choose position in chain: before or after existing steps
5. Save — adhoc approver receives notification and must approve before workflow proceeds

---

## SECTION 2: OFFER LETTER TEMPLATE CREATION

### Overview
Offer letter templates define the content and layout of the offer document sent to candidates. Templates use merge tokens to auto-populate candidate and job data.

**Navigation:** Admin Center → Recruiting → Offer Letter Templates

### How to Create an Offer Letter Template

1. Admin Center → Recruiting → **Offer Letter Templates**
2. Click **Create New Template**
3. Enter Template Name (e.g. "EX3 UK Permanent Offer Letter")
4. Select **Country/Region** (e.g. United Kingdom)
5. Select **Language** (e.g. en_GB)
6. Select **Employment Type** applicability (Permanent / Contract / Part-Time)
7. In the template editor, write the offer letter content
8. Insert merge tokens where dynamic data is needed (see token reference below)
9. Click **Save and Publish**

### Merge Token Reference — Full List

| Token | Data Pulled |
|-------|------------|
| `{{candidate_first_name}}` | Candidate first name |
| `{{candidate_last_name}}` | Candidate last name |
| `{{candidate_full_name}}` | Candidate full name |
| `{{job_title}}` | Job title from requisition |
| `{{department}}` | Department from requisition |
| `{{location}}` | Work location |
| `{{start_date}}` | Start date from offer form |
| `{{salary}}` | Base salary from offer form |
| `{{currency}}` | Currency from offer form or system config |
| `{{contract_type}}` | Employment type (Permanent / Contract) |
| `{{notice_period}}` | Notice period from offer form |
| `{{annual_leave}}` | Annual leave entitlement |
| `{{probation_period}}` | Probation period from offer form |
| `{{hiring_manager_name}}` | Hiring Manager name from requisition |
| `{{recruiter_name}}` | Recruiter name from requisition |
| `{{company_name}}` | Legal entity / company name |
| `{{company_address}}` | Company address from system config |
| `{{offer_expiry_date}}` | Offer expiry date set by recruiter |
| `{{req_id}}` | Requisition ID number |

### Conditional Sections in Offer Letters
Conditional sections show or hide content based on field values.

**Example — show a remote working clause only for remote roles:**
```
{{#if work_arrangement == "Remote"}}
  This role is approved for fully remote working. You are expected to...
{{/if}}
```

**Example — different notice periods by seniority:**
```
{{#if job_grade >= "Senior"}}
  Your notice period is 3 months.
{{else}}
  Your notice period is 1 month.
{{/if}}
```

**How to add conditional sections:**
1. In the template editor, use the **Insert Condition** button
2. Select the field, operator, and value
3. Write the conditional content in the true/false blocks
4. Preview to verify logic before publishing

### Country and Employment Type Variants
Best practice is to create separate templates per country and employment type:

| Template Name | Country | Employment Type |
|--------------|---------|-----------------|
| EX3 UK Permanent Offer | United Kingdom | Permanent |
| EX3 UK Contract Offer | United Kingdom | Contract |
| EX3 UK Part-Time Offer | United Kingdom | Part-Time |
| EX3 UAE Offer | United Arab Emirates | Permanent |
| EX3 US Offer | United States | Permanent |

**How to select the correct template when extending an offer (RCM-RC-113):**
1. Open candidate profile → Action → Offer Letter
2. Select Country/Region
3. Select Language
4. Available templates filter automatically by country and employment type
5. Select the correct template → validate tokens → send

### Template Versioning
- Templates can be versioned to maintain a history of changes
- When editing an active template: click **Create New Version** rather than editing in place
- Previous versions remain accessible for auditing
- Only one version can be **Active** at a time — activate the new version when ready
- Retire old versions to prevent accidental use

### How to Test an Offer Letter Template
1. Create a test requisition and candidate in a sandbox environment
2. Progress the candidate to Offer stage
3. Generate the offer letter using the template
4. Review every merge token — confirm all data populates correctly
5. Check conditional sections trigger as expected
6. Review formatting, line breaks, and page layout in the preview
7. Download as PDF to verify final output

---

## SECTION 3: SCREENING QUESTIONS & KNOCKOUT LOGIC

### Library Management

**Navigation:** Admin Center → Recruiting → Screening Question Library

#### Question Types
| Type | Description | Best Used For |
|------|-------------|--------------|
| Yes / No | Binary answer | Eligibility checks (e.g. "Do you have the right to work in the UK?") |
| Multiple Choice (Single) | One answer from a list | Qualification level, years of experience |
| Multiple Choice (Multi) | Multiple answers from a list | Skills or certifications held |
| Free Text | Open text response | Motivation, availability, role-specific questions |
| Number | Numeric input | Years of experience, salary expectation |
| Date | Date picker | Availability to start |

#### How to Create a Screening Question
1. Admin Center → Recruiting → Screening Question Library → **Create New**
2. Enter Question Text
3. Select Question Type
4. If Multiple Choice: add answer options
5. Set **Required** flag if the candidate must answer
6. Set **Knockout** flag if a wrong answer should disqualify the candidate
7. If Knockout: select which answer(s) are the correct/required answer
8. Set Knockout Action: **Disqualify immediately** or **Flag for review**
9. Add a Knockout Message (shown to disqualified candidates)
10. **Save and Publish**

### Knockout Logic — How It Works
- When a candidate answers a knockout question incorrectly, one of two things happens:
  - **Hard Knockout:** Candidate cannot proceed — application is immediately blocked
  - **Soft Knockout:** Candidate can complete the application but is flagged for recruiter review
- Knockout answers appear highlighted on the candidate's application for the recruiter

#### Example Knockout Questions
| Question | Knockout Answer | Action |
|----------|----------------|--------|
| Do you have the right to work in the UK? | No | Hard Knockout |
| Do you hold a valid driving licence? | No | Soft Knockout (flag) |
| Do you have 3+ years of SAP experience? | No | Soft Knockout (flag) |
| Are you available to start within 4 weeks? | No | Soft Knockout (flag) |

### Validation Rules
- **Required fields:** Candidates cannot submit the application without answering required questions
- **Character limits:** Free text questions can have min/max character limits set
- **Number ranges:** Number questions can enforce min/max values (e.g. salary expectation between £20,000 and £200,000)
- **Date validation:** Date questions can enforce future-only or past-only dates

### Managing the Library
- **Deactivate** questions that are no longer needed (do not delete — preserves historical data)
- **Clone** questions to create variations without rebuilding from scratch
- **Categories:** Organise questions into categories (e.g. Eligibility, Experience, Availability) for easier searching when adding to requisitions
- **Translations:** Add translated versions of questions for multilingual postings

---

## SECTION 4: CUSTOM FIELDS & FORM BUILDER

### Overview
Custom fields allow you to capture additional data on Job Requisitions, Candidate Profiles, or Offer Forms that is not included in the standard SAP SuccessFactors fields.

**Navigation:** Admin Center → Recruiting → Configure Applicant Status (for status fields) / Manage Job Requisition Field Settings / Form Template Configuration

### How to Create a Custom Field on a Job Requisition

1. Admin Center → **Manage Job Requisition Field Settings** (or Recruiting Configuration → Field Settings)
2. Select the template to add the field to (e.g. Standard Job Requisition)
3. Click **Add Field**
4. Configure:
   - **Field ID:** Unique internal identifier (e.g. `custom_field_budget_code`)
   - **Field Label:** Display name shown on the form (e.g. "Budget Code")
   - **Field Type:** Text, Number, Dropdown, Date, Checkbox, Lookup
   - **Required:** Yes / No
   - **Editable by:** Originator only / Recruiter / All
   - **Visible to:** Internal users only / Also visible to candidate
5. If Dropdown: add the list of values
6. Save

### Field Dependencies (Conditional Visibility)
Field dependencies show or hide a field based on the value of another field.

**Example:** Show "Sponsorship Details" field only if "Visa Sponsorship Required" = Yes

**How to set up:**
1. In Field Settings → select the dependent field
2. Click **Add Dependency**
3. Select the controlling field (e.g. "Visa Sponsorship Required")
4. Set condition: when controlling field = "Yes"
5. Set action: **Show** the dependent field
6. Save

### Form Designer — Requisition Layout
The Form Designer controls the layout and section order of the Job Requisition form.

**Navigation:** Admin Center → Recruiting → **Job Requisition Form Template**

1. Select the template to edit
2. Drag and drop fields to rearrange
3. Add **Section Headers** to group related fields (e.g. "Job Details", "Compensation", "Posting Information")
4. Set fields as **Read Only** at specific stages (e.g. salary becomes read-only after approval)
5. Set fields as **Hidden** at specific stages if not relevant
6. Preview the form before saving
7. Save and activate

### Custom Fields on Candidate Profile
Additional fields can be added to the candidate application form:

**Navigation:** Admin Center → Recruiting → **Candidate Profile Template**

- Follow same process as requisition custom fields
- Fields appear on the application form filled in by the candidate
- Or on the internal candidate record visible only to recruiters

### Custom Fields on Offer Form
**Navigation:** Admin Center → Recruiting → **Offer Letter Template Settings** → Offer Form Fields

- Add custom fields specific to your offer process (e.g. Sign-on Bonus, Car Allowance, Relocation Package)
- These fields can also be mapped as merge tokens in the offer letter template

---

## SECTION 5: TALENT POOLS & CANDIDATE RE-ENGAGEMENT

### What is a Talent Pool?
A Talent Pool is a saved group of candidates who have expressed interest or been identified as suitable for future roles, even if no current vacancy exists.

**Navigation:** Module Picker → Recruiting → Talent Pools

### How to Create a Talent Pool
1. Recruiting → Talent Pools → **Create New Pool**
2. Enter Pool Name (e.g. "SAP SuccessFactors Consultants — UK")
3. Add description and owner (recruiter responsible)
4. Set visibility: Private (recruiter only) or Shared (all recruiters)
5. Save

### How to Add Candidates to a Talent Pool
**From a Job Requisition:**
1. Recruiting → open requisition → Candidates tab
2. Select candidate(s) using checkboxes
3. Click **Action → Add to Talent Pool**
4. Select the pool → Save

**From Candidate Search:**
1. Recruiting → Candidate Search
2. Search by skills, location, experience
3. Select candidates → **Add to Talent Pool**

**From Career Site (candidate self-registers):**
- Candidates can opt in to a talent pool when registering on the career site without applying for a specific role

### Tagging Candidates
Tags allow you to label candidates with keywords for easier filtering.
- Open candidate profile → **Tags** section → add tags (e.g. "SAP", "Senior", "Passive Candidate", "Re-engage 2025")
- Search and filter talent pools by tag

### Bulk Operations on Talent Pools
1. Open Talent Pool → select multiple candidates using checkboxes
2. Available bulk actions:
   - **Send Email** — bulk communication to selected candidates
   - **Add to Requisition** — move candidates into an active pipeline
   - **Remove from Pool** — clean up pool
   - **Export** — export candidate list to CSV/Excel
   - **Add Tag** — bulk tag multiple candidates

### Candidate Re-Engagement Workflow
1. Open Talent Pool → filter by tag or last contact date
2. Select candidates to re-engage
3. Click **Send Email** → select an email template (e.g. "New Opportunity Available")
4. Personalise the message with merge tokens (candidate name, job title)
5. Send — communication is logged on each candidate's profile
6. Monitor responses — candidates who express interest can be moved directly into an active requisition

### Pipeline from Talent Pool to Requisition
1. Open Talent Pool → select candidate
2. Click **Action → Add to Job Requisition**
3. Search and select the requisition
4. Select initial pipeline status (e.g. Screening)
5. Save — candidate appears in requisition pipeline

---

## SECTION 6: ADVANCED REPORTING & DASHBOARDS

### Custom Report Builder
**Navigation:** Module Picker → Analytics → Report Centre → **Create Report**

#### How to Build a Custom Recruiting Report
1. Click **Create Report**
2. Select subject area: **Recruiting** (or Recruiting — Job Requisitions / Candidates / Offers)
3. Add columns:
   - Drag fields from the left panel to the report canvas
   - Common fields: Req ID, Job Title, Requisition Status, Created Date, Filled Date, Department, Location, Recruiter, Candidate Name, Application Date, Current Status, Offer Amount, Hire Date
4. Apply filters:
   - Date range (e.g. requisitions created in last 90 days)
   - Department, Location, Recruiter, Status
5. Add sorting and grouping (e.g. group by Department, sort by Created Date)
6. Click **Run** to preview
7. Save report with a name
8. Schedule for automatic delivery: set frequency (daily/weekly/monthly), format (Excel/CSV/PDF), and recipients

### Key Pipeline Metrics to Track

| Metric | How to Calculate | Why It Matters |
|--------|-----------------|----------------|
| Time to Fill | Hire Date − Requisition Created Date | Overall recruiting efficiency |
| Time to Hire | Offer Accepted Date − Application Date | Candidate experience speed |
| Time to Approve | Approval Completed Date − Requisition Submitted Date | Approval process efficiency |
| Offer Acceptance Rate | Offers Accepted ÷ Offers Extended × 100 | Quality of offer and process |
| Application to Interview Rate | Interviews Scheduled ÷ Applications × 100 | Screening effectiveness |
| Interview to Offer Rate | Offers Made ÷ Interviews Completed × 100 | Interview quality |
| Source Effectiveness | Hires by Source ÷ Total Hires × 100 | ROI on sourcing channels |
| Cost per Hire | Total Recruiting Cost ÷ Total Hires | Budget efficiency |

### Configuring Pipeline Dashboards
**Navigation:** Analytics → Recruiting Dashboard → **Customise Dashboard**

1. Click **Add Widget**
2. Choose widget type: Bar Chart, Pie Chart, Funnel, KPI Tile, Table
3. Select the data source (e.g. Job Requisitions, Candidates)
4. Configure the metric (e.g. count of candidates by status)
5. Set filters (date range, department, recruiter)
6. Arrange widgets by drag and drop
7. Save dashboard layout

### Forecasting Reports
- **Headcount Forecast:** Requisitions planned vs filled by department and quarter
- **Pipeline Forecast:** Candidates at each stage projected to hire based on historical conversion rates
- **Offer Acceptance Forecast:** Based on average offer acceptance rate, project how many offers need to be made to fill X roles

These are built as custom reports using calculated fields in the Report Centre.

---

## SECTION 7: SYSTEM INTEGRATIONS

### Employee Central (EC) ↔ RCM Integration

**What syncs from EC to RCM:**
- Org structure (departments, divisions, cost centres)
- Position data (when Position Management is enabled in EC)
- User accounts (employees who can act as Hiring Managers, Approvers, etc.)
- Job classifications and families

**What syncs from RCM to EC:**
- New hire data when candidate is moved to Hired status
- Position fill status (position moves from vacant to filled)
- Headcount data

**Configuration:**
- Admin Center → Platform → **Integration Centre** or **Manage Business Configuration**
- EC-RCM integration is managed via the **Position Management** and **Hire Employee** business rules
- Requires both EC and RCM modules to be active and licensed

**Testing the EC-RCM Integration:**
1. Create a position in EC Position Management
2. Verify it appears in the RCM Position Org Chart
3. Create a requisition from the position in RCM
4. Progress a test candidate to Hired
5. Verify new hire record appears in EC → People → New Hires

### LinkedIn Recruiter Integration

**What it does:**
- Synchronises candidate data between LinkedIn Recruiter and SAP SuccessFactors RCM
- Allows recruiters to export LinkedIn profiles directly to RCM as candidates
- Syncs InMail and notes from LinkedIn to the candidate record in RCM
- Allows job postings to be pushed directly to LinkedIn from RCM

**Setup:**
- Admin Center → Recruiting → **LinkedIn Integration**
- Requires a LinkedIn Recruiter licence and the LinkedIn RSC (Recruiter System Connect) contract
- Enter LinkedIn API credentials
- Map LinkedIn fields to RCM candidate profile fields

**Posting Jobs to LinkedIn from RCM:**
1. Job Requisition → Job Postings → **Add Posting**
2. Select channel: **LinkedIn**
3. Set posting details (title, description, location)
4. Set start and end date
5. Post — job appears on LinkedIn within minutes

### Background Check Integrations

**Supported providers:** Sterling, HireRight, Checkr, First Advantage (configuration varies by provider)

**How it works:**
1. Recruiter moves candidate to **Post-Offer Background Check** status
2. RCM automatically triggers the background check request to the provider
3. Provider sends results back to RCM via API
4. Results appear on the candidate profile
5. Recruiter reviews results and progresses or declines the candidate

**Setup:**
- Admin Center → Recruiting → **Background Check Configuration**
- Select provider
- Enter API credentials from the background check provider
- Map candidate fields (name, date of birth, address) to the provider's required fields
- Set up status mapping (pass/fail/pending → RCM candidate status)

**Testing:**
- Use sandbox / test credentials from the provider
- Run a test check on a dummy candidate
- Verify results return to RCM correctly

### HRIS / Third-Party ATS Integrations
- SAP SuccessFactors supports integrations via **OData API**, **SFTP file-based integration**, and the **Integration Centre**
- Common integrations: Workday, SAP HCM, Oracle HCM, PeopleSoft
- File-based integrations: scheduled exports of hire data in CSV/XML format
- API-based integrations: real-time data sync via REST/OData

**Integration Centre (Admin Center → Platform → Integration Centre):**
- Build and manage inbound/outbound integrations without custom code
- Configure field mappings, triggers (e.g. on Hire), and schedules
- Monitor integration run history and errors

### Single Sign-On (SSO)
- SAP SuccessFactors supports SAML 2.0 and OAuth SSO
- Users log in via their company identity provider (Microsoft Entra / Azure AD, Okta, Ping Identity)
- No separate SuccessFactors password required
- Setup: Admin Center → Platform → **SSO Configuration** → enter IdP metadata

---

## SECTION 8: MULTI-REGION & MULTI-LANGUAGE CONFIGURATION

### Localisation Overview
SAP SuccessFactors RCM supports deployment across multiple countries with region-specific configurations.

**Key areas to localise:**
- Job requisition forms (different fields per country)
- Offer letter templates (legal requirements vary by country)
- Screening questions (right to work questions per region)
- Career site language and content
- Date formats, currency, and address formats

### How to Set Up Multiple Languages

**System languages:**
1. Admin Center → Company Settings → **Language Packs**
2. Enable the required languages (e.g. en_GB, fr_FR, de_DE, ar_SA)
3. Users see the system in their profile language preference

**Translating job postings:**
1. Job Requisition → Job Postings → **Add Language**
2. Select target language
3. Enter translated job title and description
4. Post — candidates see the posting in their preferred language

**Translating offer letters:**
1. Create a separate offer letter template for each language
2. Name clearly: e.g. "EX3 France Offer Letter — French (fr_FR)"
3. When extending offer, select the template matching the candidate's language

**Translating screening questions:**
1. Screening Question Library → open question
2. Click **Add Translation**
3. Select language → enter translated question text and answer options
4. Save — candidates see questions in their profile language

### Regional Compliance Configuration

**Right to work questions — must be country-specific:**
- UK: "Do you have the right to work in the United Kingdom?"
- UAE: "Do you hold a valid UAE work visa or are you a UAE/GCC national?"
- EU: "Are you authorised to work in the European Union?"
- US: "Are you legally authorised to work in the United States?"

**Data retention by region:**
- UK / EU (GDPR): maximum retention typically 6–12 months for unsuccessful candidates
- UAE: follow local labour law requirements
- US: follow EEOC retention requirements (typically 1–2 years)

**Currency configuration:**
1. Admin Center → Recruiting → **Currency Settings**
2. Add currencies for each operating region (GBP, USD, EUR, AED, etc.)
3. Salary fields on offer forms will show currency options based on the position location
4. Exchange rates can be set manually or synced from an external source

### Multi-Entity / Multi-Company Setup
For organisations with multiple legal entities:
- Each entity can have its own: career site, offer letter templates, approval workflows, email templates
- Requisitions are linked to a specific legal entity
- Reporting can be filtered or consolidated by entity
- Setup: Admin Center → Company Settings → **Manage Business Units / Legal Entities**

---

## SECTION 9: EEO / DIVERSITY TRACKING & COMPLIANCE REPORTING

### What is EEO?
Equal Employment Opportunity (EEO) data tracks the demographic characteristics of applicants and hires to ensure fair and compliant hiring practices.

### How to Enable EEO Data Collection
1. Admin Center → Recruiting → **EEO Configuration**
2. Enable EEO data collection on the candidate application form
3. Select which fields to collect:
   - Gender
   - Ethnicity / Race
   - Disability status
   - Veteran status (US)
4. Set collection point: during application, after application submission, or optional separate form
5. Add the standard EEO disclaimer: "This information is collected for compliance purposes only and will not affect your application."

### EEO Reporting
**Navigation:** Analytics → Report Centre → Recruiting → **EEO Report**

Standard EEO report shows:
- Applicants by gender, ethnicity, disability status
- Hires by demographic group
- Pipeline conversion rates by demographic group (to identify potential bias points)
- Rejection reasons by demographic group

### Diversity Metrics Dashboard
- Build a custom dashboard widget showing diversity at each pipeline stage
- Track representation: % of candidates from underrepresented groups at application, interview, offer, and hire stages
- Use funnel chart to visualise where drop-off occurs

### Data Privacy for EEO
- EEO data must be stored separately from the hiring decision
- Hiring Managers typically cannot see EEO data — only HR / Compliance roles
- Configure visibility via Role-Based Permissions: EEO fields visible only to HR Admin role

---

## SECTION 10: CANDIDATE PORTAL CUSTOMISATION

### Career Site Builder — Portal Pages
**Navigation:** Admin Center → Career Site Builder

#### Key Pages to Configure
| Page | Purpose |
|------|---------|
| Home Page | Landing page — company branding, featured jobs |
| Job Search | Search interface — filters, job listings |
| Job Detail | Individual job posting page |
| Application Form | Candidate application steps |
| Candidate Dashboard | My Applications, My Profile, My Offers |
| Account Creation | Registration page |
| Login Page | Returning candidate login |
| Offer Acceptance | Where candidates view and accept offers |

#### How to Edit a Career Site Page
1. Career Site Builder → select the page to edit
2. Use the drag-and-drop editor to add/remove/rearrange components
3. Components available: Hero Banner, Job Search Bar, Featured Jobs, Company Logo, Text Block, Image, Video, Social Links, Testimonials
4. Edit content directly in each component
5. Preview in desktop and mobile view
6. Publish when ready

### Communication Preferences
Candidates can control which email notifications they receive:
- Application status updates
- Interview invitations
- Offer notifications
- Talent pool communications
- Job alert emails (new jobs matching their profile)

**Admin configuration:**
1. Admin Center → Recruiting → **Email Notification Templates**
2. Enable or disable specific notification types
3. Edit the content of each email template — use merge tokens for personalisation
4. Set sender name and reply-to address for all candidate-facing emails

### Candidate-Facing Email Templates — Key Ones to Configure
| Template | Trigger |
|----------|---------|
| Application Received | Candidate submits application |
| Application Status Update | Candidate status changes in pipeline |
| Interview Invitation | Interview scheduled by recruiter |
| Interview Confirmation | Candidate confirms interview |
| Interview Reminder | 24 hours before interview |
| Offer Notification | Offer extended to candidate |
| Offer Accepted Confirmation | Candidate accepts offer |
| Rejection Email | Candidate moved to rejected status |
| Account Verification | New candidate account created |
| Password Reset | Candidate requests password reset |

---

## SECTION 11: BULK DATA OPERATIONS

### Importing Positions
Use bulk import to create multiple positions at once, rather than creating them individually in the Position Org Chart.

**Navigation:** Admin Center → Import and Export Data → **Import**

1. Download the Position import template (CSV or Excel)
2. Fill in required columns:
   - Position Code
   - Position Title
   - Department
   - Location
   - Reports To (parent position code)
   - Status (Active)
   - Cost Centre
3. Save the file
4. Admin Center → Import → select **Position** as the object type
5. Upload the file
6. Review the validation report — fix any errors
7. Confirm import → positions created in the system

### Importing Job Requisitions in Bulk
Bulk requisition import is typically used during initial system go-live or when migrating from another ATS.

1. Download the Job Requisition import template
2. Fill in all required fields per requisition
3. Import via Admin Center → Import and Export Data → Import → select **Job Requisition**
4. Validate and confirm

### Importing Candidate Data (Data Migration)
When migrating candidates from a legacy ATS:
1. Export candidate data from legacy system in CSV format
2. Map legacy fields to SAP SuccessFactors candidate profile fields
3. Admin Center → Import → select **Candidate Profile**
4. Upload and validate
5. Review import errors (common: missing required fields, invalid email format, duplicate records)
6. Confirm — candidates appear in the candidate database

### Exporting Data
1. Admin Center → Import and Export Data → **Export**
2. Select the object type (Positions, Requisitions, Candidates, Applications)
3. Select fields to include
4. Apply filters if needed (e.g. active requisitions only)
5. Export as CSV or Excel
6. Use for: data audits, reporting outside SuccessFactors, migration to another system, backup

### Bulk Status Updates
Update multiple candidate statuses at once without opening each record individually:
1. Recruiting → Job Requisition → Candidates tab
2. Select multiple candidates using checkboxes
3. Click **Action → Move Candidate**
4. Select the target status
5. Add a comment (optional)
6. Click **Move** — all selected candidates update simultaneously

### Bulk Email to Candidates
1. Recruiting → Candidates tab (or Talent Pool)
2. Select candidates
3. Click **Action → Send Email**
4. Select email template or write custom message
5. Review recipients
6. Send — all selected candidates receive the email, logged on each profile
