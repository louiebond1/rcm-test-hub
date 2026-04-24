# EX3 SAP SuccessFactors RCM — Complete Knowledge Base

**Client:** veritasp01T2  
**System:** SAP SuccessFactors Recruiting Management (RCM)  
**Environment:** https://hcm-eu10-preview.hr.cloud.sap/login?company=veritasp01T2  
**Test User:** Alex Brackley  

---

## IMPORTANT: Position vs Job Requisition

These are two different things in SAP SuccessFactors:

- **Position** — An organisational slot in the Position Org Chart. Managed under Company Info. A position must exist before a job requisition can be raised against it. Positions are managed in the Position Org Chart, NOT in Admin Center Manage Data (that is Employee Central / EC functionality).
- **Job Requisition** — A request to recruit for a position. Created from the position in the Position Org Chart, or from within the Recruiting module. Managed under Module Picker → Recruiting → Job Requisitions.

If a user asks how to "create a position", "add a position", or "copy a position" — always refer to the Position Org Chart process (RCM-RC-101 below). Do NOT direct them to Admin Center → Manage Data, which is EC.

---

## ROLES

| Role | Description |
|------|-------------|
| Originator | Creates positions and raises job requisitions. Typically an HR Business Partner. |
| Recruiter | Approves requisitions, posts jobs, manages candidate pipeline, prepares offers. |
| Hiring Manager | Reviews candidates (read-only), conducts interviews, provides feedback, approves offers. |
| Candidate | External or internal applicant who applies, self-schedules interviews, accepts/declines offers. |
| Approver | Approves or declines offers in the approval chain. |

---

## HOW TO PROXY / IMPERSONATE ANOTHER USER

Used to switch between roles during testing without separate logins.

1. Top-right corner → click your name → dropdown menu appears
2. Select **Proxy Now**
3. Type the full name of the target user → select from results
4. Confirm proxy is active (target user's home page displays)

---

## SECTION 1: POSITION MANAGEMENT

### How to Create a Position / Copy a Position (RCM-RC-101)

**Role:** Originator  
**Navigation:** Module Picker → Company Info → Position Org Chart

1. From the Module Picker, navigate to **Company Info → Position Org Chart**
2. Search for the parent position (e.g. POS100001) using the search bar
3. Select the parent position → click **Action**
4. Choose either:
   - **Create same level Position** — creates a new peer position at the same level
   - **Copy Position** — duplicates the selected position with pre-filled fields
5. Fill in all required fields:
   - Position Title
   - Department
   - Location
   - Cost Center
6. Click **Save** → system assigns a Position Number (e.g. POS100121)
7. **Note the Position Number** — needed for creating the job requisition

> Creating a position is NOT done in Admin Center → Manage Data. That path is for Employee Central (EC) object management and is not part of the RCM recruiting workflow.

---

## SECTION 2: JOB REQUISITION

### How to Create a Job Requisition from a Position (RCM-RC-102)

**Role:** Originator  
**Navigation:** Module Picker → Company Info → Position Org Chart

1. In the Position Org Chart, search for the position using the Position Number from RCM-RC-101
2. Select the position → click **Action → Create Job Requisition**
3. Select template: **Standard Job Requisition** → click **Create**
4. Fill all required fields:
   - Hiring Manager
   - Target Start Date
   - Number of Openings
5. Click the requisition icon at the top → note the **Req ID** and confirm position details are correct

### How to Send a Requisition for Approval (RCM-RC-103)

**Role:** Originator

1. Ensure all required fields are completed on the requisition form
2. Click **Send to Next Step** (bottom-right corner)
3. Confirm the action → requisition routes to Recruiter; status updates

### How to Approve a Requisition (RCM-RC-104)

**Role:** Recruiter

1. Log in (or proxy) as Recruiter
2. Locate the **Approvals** tile on the home page → click
3. Review requisition details in full
4. In the **Posting Information** section → add a screening question from the question library
5. Assign competencies from the competency library (used for Interview Central)
6. Click **Approve** → status updates to Approved; ready for posting

---

## SECTION 3: JOB POSTING

### How to Post a Job (RCM-RC-105)

**Role:** Recruiter  
**Navigation:** Module Picker → Recruiting → Job Requisitions

1. Navigate to **Module Picker → Recruiting**
2. Select **Job Requisitions** from the task bar
3. Locate and open the approved Job Requisition
4. Click **Job Postings** within the requisition
5. Select posting type: **External Private**
6. Set **Start Date** and **End Date** (+7 days recommended)
7. Hover over the chain-link icon → copy the posting URL
8. Open URL in new tab to confirm it loads correctly
9. **Save the posting URL** — needed for candidate application testing

---

## SECTION 4: CANDIDATE APPLICATION

### How a Candidate Applies for a Job (RCM-RC-106)

**Role:** Candidate

1. Open a separate browser or incognito window → paste the job posting URL from RCM-RC-105
2. Review the posting → click **Apply**
3. Create a new candidate account OR log in with existing career site credentials
4. Verify the **Data Privacy Consent Statement (DPCS)** appears during account creation
5. Complete email verification if prompted (check inbox for verification email)
6. Fill all required application fields:
   - CV / Resume upload
   - Address
   - Screening question responses
7. Click **Submit**

---

## SECTION 5: CANDIDATE REVIEW & PIPELINE MANAGEMENT

### How to Review and Progress a Candidate (RCM-RC-107)

**Navigation:** Module Picker → Recruiting → Job Requisitions → [Requisition] → Candidates

**Recruiter actions:**
1. Navigate to the Job Requisition → click **Candidates** tab
2. Select candidate → **Move Candidate** → move to **Screening** status
3. Click candidate name → review application info (name, contact, CV, screening responses)
4. Verify all documents and screening responses are complete
5. **Move Candidate** to **Hiring Manager Review** status

**Hiring Manager actions:**
1. Proxy as Hiring Manager
2. Navigate to Recruiting → Job Requisitions → confirm candidate shows **HM Review** status
3. Click candidate name → review application (view only, no edits)
4. Select candidate → **Move Candidate** to **Proceed** status

### Candidate Pipeline Status Order

Screening → Hiring Manager Review → Proceed → Schedule Interview → Prepare Offer → Offer Extended → Hired

---

## SECTION 6: INTERVIEW SCHEDULING

### How to Schedule an Interview (RCM-RC-108a)

**Role:** Recruiter  
**Navigation:** Module Picker → Recruiting → Job Requisitions → [Requisition]

1. Navigate to the relevant Job Requisition
2. Click the **Candidates** tab → view candidate pipeline
3. Select the candidate using the checkbox
4. Click **Move Candidate** → move to **Schedule Interview** status
5. Click **Interview Scheduling** at the top of the page
6. Find the Req ID tile → click **Not Started**
7. Choose Interview Type: Phone / Virtual / Face-to-Face
8. Set the interviewer by Name or Role → select **Hiring Manager**
9. Click **Find Availability** → Hiring Manager's calendar opens
10. Click **+ Add Custom Slot** → select date and time → **Add and Select**
11. Click **Continue** → check **Book this slot for candidates** → click **Send to candidate**

### How a Candidate Confirms an Interview (RCM-RC-108b)

**Role:** Candidate

1. Log in to the candidate portal using credentials from RCM-RC-106
2. Check email inbox for interview invitation from SuccessFactors
3. Click the link in the email → interview self-scheduling page opens
4. Review the proposed date, time, and format
5. Select the proposed time slot → click **Confirm** or **Book**
6. Verify confirmation message appears → check confirmation email received
7. Navigate to **My Applications** → verify interview status shows **Confirmed** with correct date/time

---

## SECTION 7: INTERVIEW FEEDBACK

### How to Submit Interview Feedback (RCM-RC-109)

**Role:** Hiring Manager

1. Log in (or proxy) as Hiring Manager
2. Locate the **Provide Interview Feedback** tile on the home page → click
3. Select the interview to provide feedback on
4. For each competency, assign a rating using the **EX3 Interview Assessment Scale:**
   - 0 = Not Applicable
   - 1 = Below Expectations
   - 2 = Partially Meets Expectations
   - 3 = Meets Expectations
   - 4 = Exceeds Expectations
   - 5 = Exceptional
5. Provide overall recommendation (Recommended / Not Recommended) and comments → **Save**

**Recruiter verification:**
- Proxy back as Recruiter → confirm candidate feedback is visible on the application profile

---

## SECTION 8: OFFER MANAGEMENT

### How to Prepare an Offer for Approval (RCM-RC-110)

**Role:** Recruiter  
**Navigation:** Module Picker → Recruiting → Job Requisitions → [Requisition] → Candidates

1. Navigate to the Job Requisition → click **Candidates** tab
2. Find the candidate → check the checkbox next to their name
3. Click **Action → Move Candidate** → select status: **Prepare Offer** → add comment (optional) → click **Move**
4. Click candidate name → open profile → click the **additional action menu (three dots)**
5. Click **Initiate Offer Approval**
6. Select template: **EX3 Offer Approval Template**
7. Fill all offer fields:
   - Salary
   - Start Date
   - Contract Type
8. Add an Adhoc approver if needed via the additional approver option
9. Click **Send for Approval**

### How to Approve or Decline an Offer (RCM-RC-111)

**Role:** Approver (Hiring Manager, then Recruiter)

1. Log in (or proxy) as the first approver (Hiring Manager) → **Job Offer** tile appears on home page
2. Click tile → offer opens for review
3. Review offer details (Type of Hire, Name, Salary, Start Date)
4. Add comment (optional) → click **Approve** or **Decline**
5. For full approval chain: repeat as second approver (Recruiter)
6. Once all approvers approve → status = **Offer Approved**

### How to Verify Offer Details (RCM-RC-112)

**Role:** Recruiter

1. Navigate to Recruiting → open Job Requisition → click **Candidates** tab
2. Click candidate name → navigate to **Applicant Info** section
3. Verify **Start Date** matches what was entered in RCM-RC-110
4. Verify **Offered Salary** matches what was entered in RCM-RC-110

### How to Extend an Offer to a Candidate (RCM-RC-113)

**Role:** Recruiter

1. Navigate to Recruiting → open requisition → move candidate to **Offer Extended** status
2. Open candidate profile → click additional action menu (three dots)
3. Hover over **Offer** → click **Offer Letter**
4. Select:
   - Country/Region: **United Kingdom**
   - Language: **en_GB**
   - Template: **EX3 UK Offer Letter**
5. Validate all merge tokens populate correctly: Department, Job Title, Salary, Start Date
6. Edit any offer letter elements as needed → add attachments if required
7. Click **Next Step** to preview the offer letter
8. Select delivery method → send offer letter to candidate
9. Click **Send** → candidate status updates to **Offer Extended**

### How a Candidate Accepts or Declines an Offer (RCM-RC-114)

**Role:** Candidate

1. Check email inbox for **Offer of Employment** email → click **View / Accept Offer**
2. Sign in to the career site using candidate credentials
3. Navigate to **My Offers** → offer is visible
4. Review offer letter → **Accept**, **Decline**, or **Download** options present
5. To accept: click **Accept** → confirmation pop-up → confirm acceptance
6. To decline: click **Decline** → enter reason in comment box → confirm
7. Verify status updated in **My Offers** after decision

### How to Check Offer Status (RCM-RC-115)

**Role:** Recruiter

1. Navigate to Recruiting → Job Requisitions tab → open requisition
2. Click **Candidates** → open candidate profile
3. Confirm status = **Offer Approved** (or reflects candidate's decision)

---

## SECTION 9: HIRING & ONBOARDING

### How to Move a Candidate to Hired (RCM-RC-116)

**Role:** Recruiter

1. Navigate to Recruiting → open Job Requisition → locate the accepted candidate
2. Check checkbox next to candidate name → click **Action → Move Candidate**
3. Select appropriate post-offer status:
   - **Post-Offer Background Check** (if background screening configured)
   - Or move directly to **Hirable**
4. Confirm all previous steps are complete (offer accepted, details verified)
5. Select **Hired** from status dropdown → click **Save**
6. Candidate moves to **Hired** status → requisition fulfilled
7. If Onboarding is configured, the onboarding trigger fires automatically

---

## SECTION 10: SYSTEM ACCESS & NAVIGATION

### How to Log In

1. Open browser (Firefox / Chrome / Edge)
2. Navigate to: https://hcm-eu10-preview.hr.cloud.sap/login?company=veritasp01T2
3. Enter Username and Password → click Login
4. Bookmark the URL for quick access

### Module Picker Navigation

- Click **Home** (with the dropdown arrow) in the top-left → Module Picker opens
- Key modules: **Recruiting**, **Company Info**, **Admin Center**, **Onboarding**

### Key Navigation Paths

| Task | Navigation |
|------|-----------|
| Create / Copy Position | Module Picker → Company Info → Position Org Chart |
| Create Job Requisition | Position Org Chart → select position → Action → Create Job Requisition |
| View Job Requisitions | Module Picker → Recruiting → Job Requisitions |
| Manage Approvals | Home Page → Approvals tile |
| Interview Scheduling | Module Picker → Recruiting → open Requisition → Interview Scheduling |
| Submit Interview Feedback | Home Page → Provide Interview Feedback tile |
| Approve Offer | Home Page → Job Offer tile |
| Proxy as another user | Top-right name → Proxy Now |

---

## SECTION 11: CAREER SITE (Career Site Builder)

### Career Site Overview

The SAP SuccessFactors Career Site Builder (CSB) is used to configure the public-facing job portal where candidates search and apply for roles.

### Site Setup

**Navigation:** Admin Center → Career Site Builder

Key configuration areas:
- **Site Information:** Site ID, Site Name, Company Name, Site URL
- **Global Settings:** Enable/disable site-wide features
- **Google Tag Manager / Google Analytics:** Tracking integration
- **Pages:** Career site page administration
- **Candidate Accounts:** Account creation workflow settings
- **Data Privacy Consent Statement (DPCS):** Required consent configuration — must appear before or during candidate account creation

### Data Privacy Consent Statement (DPCS)

The DPCS must be presented to candidates before their personal data is collected. Verify it appears:
- During account creation
- Before or during the application process
- On the privacy statement screen

### Moving Career Site to Production

1. Generate an SSL Certificate Signing Request (CSR)
2. Procure certificate from a Certificate Authority (CA)
3. Install and configure the SSL certificate
4. Set up CNAME record to point domain to career site
5. Transition environment from Stage to Production
6. Coordinate with IT security team for certificate validation
7. Manage SSL certificate renewals before expiry

### Implementation Phases

1. **Prepare:** Readiness assessment, project planning, resource allocation, stakeholder comms
2. **Gather:** Customer environment assessment, requirements documentation, process mapping, org structure definition
3. **Design:** Site architecture, UX configuration, job posting templates, application form design, branding, mobile responsiveness
4. **Build:** Component setup, content management integration, navigation structure
5. **Engage:** Candidate outreach configuration, posting distribution channels, application workflow optimisation, communication automation
6. **Go Live:** SSL setup, CNAME configuration, production transition, certificate installation

---

## SECTION 12: KEY TEST DATA

| Item | Value |
|------|-------|
| Company ID | veritasp01T2 |
| Login URL | https://hcm-eu10-preview.hr.cloud.sap/login?company=veritasp01T2 |
| Test User | Alex Brackley |
| Example Parent Position | POS100001 |
| Example Created Position | POS100121 |
| Requisition Template | Standard Job Requisition |
| Offer Approval Template | EX3 Offer Approval Template |
| Offer Letter Template | EX3 UK Offer Letter |
| Offer Letter Country | United Kingdom |
| Offer Letter Language | en_GB |
| Interview Scale | 0 (Not Applicable) → 5 (Exceptional) |

---

## SECTION 13: COMMON ISSUES & TROUBLESHOOTING

### Screening Questions Not Appearing on Application
- Verify screening questions were added during requisition approval (RCM-RC-104)
- Check questions are published and active in the question library

### Candidate Not Receiving Emails
- Check spam/junk folders
- Verify email address on candidate account is correct
- Confirm email notification templates are active in system configuration

### Merge Tokens Not Populating in Offer Letter
- Verify all mapped fields (Department, Job Title, Salary, Start Date) are completed on the requisition and offer
- Check the offer letter template token mapping in Admin Center

### Proxy Not Working
- Ensure the target user exists and is active
- Confirm your account has Proxy permission in Role-Based Permissions

### Position Not Found in Position Org Chart
- Use Position Number (e.g. POS100121) rather than position title in the search
- Check the correct position hierarchy is being searched

### Interview Scheduling — No Availability Shown
- Verify Hiring Manager's calendar is integrated with SuccessFactors
- Try adding a Custom Slot manually via **+ Add Custom Slot**

### Requisition Stuck in Approval
- Check approval chain configuration in Admin Center
- Verify all approvers have active accounts with correct permissions
- Use Proxy to log in as each approver and check for pending approval tiles

---

## SECTION 14: END-TO-END TEST EXECUTION SEQUENCE

| Step | Scenario ID | Description | Role |
|------|------------|-------------|------|
| 1 | LOGIN-100 | System Login | Recruiter |
| 2 | LOGIN-101 | Navigate Modules | Recruiter |
| 3 | LOGIN-102 | Proxy/Impersonate User | Recruiter |
| 4 | RCM-RC-100 | Login as Originator | Originator |
| 5 | RCM-RC-101 | Create / Copy Position | Originator |
| 6 | RCM-RC-102 | Create Job Requisition from Position | Originator |
| 7 | RCM-RC-103 | Send Requisition for Approval | Originator |
| 8 | RCM-RC-104 | Approve Requisition | Recruiter |
| 9 | RCM-RC-105 | Post the Job | Recruiter |
| 10 | RCM-RC-106 | Candidate Applies | Candidate |
| 11 | RCM-RC-107 | Review & Progress Candidate | Multi-Role |
| 12 | RCM-RC-108a | Schedule Interview | Recruiter |
| 13 | RCM-RC-108b | Candidate Confirms Interview | Candidate |
| 14 | RCM-RC-109 | Submit Interview Feedback | Hiring Manager |
| 15 | RCM-RC-110 | Prepare Offer for Approval | Recruiter |
| 16 | RCM-RC-111 | Approve or Decline Offer | Approver |
| 17 | RCM-RC-112 | Verify Offer Details | Recruiter |
| 18 | RCM-RC-113 | Extend Offer to Candidate | Recruiter |
| 19 | RCM-RC-114 | Candidate Accepts / Declines Offer | Candidate |
| 20 | RCM-RC-115 | Check Offer Status | Recruiter |
| 21 | RCM-RC-116 | Move to Hired / Initiate Onboarding | Recruiter |
