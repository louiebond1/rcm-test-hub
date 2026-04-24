# EX3 SAP SuccessFactors RCM — Admin & Configuration Guide

---

## SECTION 1: ROLE-BASED PERMISSIONS (RBP)

### Overview
All access in SAP SuccessFactors is controlled by Role-Based Permissions. Each user must be assigned to a Permission Role, which belongs to a Permission Group.

**Navigation:** Admin Center → Manage Permission Roles

### Key Permission Roles for RCM

| Role | Minimum Required Permissions |
|------|------------------------------|
| Recruiter | Recruiting: Manage Job Requisitions, Post Jobs, Manage Candidates, Manage Offers, Interview Scheduling |
| Hiring Manager | Recruiting: View Job Requisitions, View Candidates, Provide Interview Feedback, Approve Offers |
| Originator / HR | Recruiting: Create Job Requisitions, Create Positions (via Position Management) |
| Approver | Recruiting: Approve Requisitions, Approve Offers |
| Admin | Full Recruiting permissions + Admin Center access |

### How to Create a Permission Role
1. Admin Center → Manage Permission Roles → **Create New**
2. Enter Role Name and Description
3. Under **Permission settings** → expand **Recruiting Permissions**
4. Check the required permissions for the role
5. Click **Save**

### How to Assign Users to a Permission Role
1. Admin Center → Manage Permission Roles → open the role
2. Click **Grant this role to** → **Add**
3. Select target group: specific users, department, or dynamic group
4. Save

### How to Grant Proxy Permission
1. Admin Center → Manage Permission Roles → open Recruiter or Admin role
2. Under **User Permissions → Administrator** → check **Proxy Management**
3. Save

---

## SECTION 2: REQUISITION FIELD REFERENCE

### Standard Job Requisition — Required Fields

| Field | Description | Notes |
|-------|-------------|-------|
| Position | Linked position from Position Org Chart | Auto-populated if created from position |
| Job Title | Title of the role | Pulled from position if linked |
| Department | Business unit / department | Mandatory |
| Location | Office / site location | Mandatory |
| Hiring Manager | Person responsible for hiring decision | Must be active SF user |
| Recruiter | Assigned recruiter | Must be active SF user |
| Target Start Date | Expected start date for new hire | Mandatory |
| Number of Openings | How many hires required | Default: 1 |
| Employment Type | Full Time / Part Time / Contract | Mandatory |
| Job Grade / Level | Seniority level | Optional depending on config |

### Standard Job Requisition — Optional / Conditional Fields

| Field | Description |
|-------|-------------|
| Internal / External | Whether to post internally, externally, or both |
| Salary Range | Min and max salary |
| Job Description | Full role description |
| Screening Questions | Added during approval step |
| Competencies | Added during approval step for Interview Central |
| Cost Centre | Finance coding for the role |
| Second Recruiter | Back-up recruiter |

---

## SECTION 3: SCREENING QUESTIONS

### What are Screening Questions?
Screening questions are presented to candidates during the application process. Responses are visible on the candidate's application for the Recruiter and Hiring Manager to review.

### How to Add Screening Questions to the Library
**Navigation:** Admin Center → Recruiting → Screening Question Library (or Job Profile Builder)

1. Navigate to **Recruiting Settings → Screening Question Library**
2. Click **Create New Question**
3. Enter question text
4. Select question type: Yes/No, Multiple Choice, Free Text, Number
5. Mark as Knockout question if required (auto-rejects candidates who answer incorrectly)
6. Set correct/preferred answer for knockout logic
7. **Save and Publish**

### How to Add Screening Questions to a Requisition
Done during the requisition approval step (RCM-RC-104):
1. Open the requisition in the Approvals tile
2. Scroll to **Posting Information** section
3. Click **Add Screening Question**
4. Search and select from the library
5. Mark as Required if the candidate must answer

---

## SECTION 4: COMPETENCY LIBRARY & INTERVIEW CENTRAL

### What are Competencies?
Competencies define the behaviours and skills assessed during interviews. They are linked to requisitions and appear on the interview feedback form for the Hiring Manager.

### How to Add Competencies to the Library
**Navigation:** Admin Center → Competency Library

1. Click **Create New Competency**
2. Enter name, description, and behavioural indicators
3. Assign to a competency category (e.g. Leadership, Technical, Communication)
4. **Save**

### How to Add Competencies to a Requisition
Done during the requisition approval step (RCM-RC-104):
1. Open requisition in Approvals tile
2. Scroll to **Interview Information** section
3. Click **Add Competency**
4. Search and select from the library
5. Save

### Interview Assessment Scale (EX3 Standard)
| Score | Label |
|-------|-------|
| 0 | Not Applicable |
| 1 | Below Expectations |
| 2 | Partially Meets Expectations |
| 3 | Meets Expectations |
| 4 | Exceeds Expectations |
| 5 | Exceptional |

---

## SECTION 5: OFFER MANAGEMENT CONFIGURATION

### Offer Approval Template
The offer approval template defines:
- Which fields appear on the offer form (Salary, Start Date, Contract Type, etc.)
- The approval chain (who must approve before the offer can be extended)
- Whether an adhoc approver can be added

**Navigation:** Admin Center → Recruiting → Offer Letter Templates (or Manage Offer Approval Process)

### Offer Letter Template — Merge Token Reference
Merge tokens automatically pull data from the requisition and offer into the offer letter document.

| Token | Pulls From |
|-------|-----------|
| {{candidate_name}} | Candidate profile |
| {{job_title}} | Job Requisition |
| {{department}} | Job Requisition |
| {{start_date}} | Offer form |
| {{salary}} | Offer form |
| {{contract_type}} | Offer form |
| {{company_name}} | System configuration |
| {{recruiter_name}} | Job Requisition |
| {{hiring_manager_name}} | Job Requisition |
| {{location}} | Job Requisition |

### How to Verify Tokens are Populating
1. Navigate to the candidate's offer letter (RCM-RC-113)
2. Before sending, review the preview
3. Any unpopulated token will show as blank or display the raw token text (e.g. `{{start_date}}`)
4. If a token is blank, check the relevant field on the requisition or offer form is completed

### Troubleshooting Blank Tokens
- `{{start_date}}` blank → Start Date not entered on offer form
- `{{salary}}` blank → Salary not entered on offer form
- `{{department}}` blank → Department not set on requisition
- `{{job_title}}` blank → Job Title missing from requisition or position

---

## SECTION 6: JOB POSTING CONFIGURATION

### Posting Types
| Type | Description |
|------|-------------|
| External Public | Visible to all candidates on the public career site |
| External Private | Accessible only via direct URL — not listed on the career site |
| Internal | Visible only to current employees logged into the internal portal |
| Agency | Shared with recruitment agencies via agency portal |

### How to Set Up Posting Channels
**Navigation:** Admin Center → Recruiting → Job Postings → Posting Channel Configuration

- Channels include: Career Site, LinkedIn, Indeed, internal job board
- Each channel must be activated and configured before it appears as a posting option

### Posting Date Best Practices
- Set End Date at least 7 days after Start Date for active roles
- Expired postings automatically close to new applications
- Extending a posting: open the Job Postings tab on the requisition → edit End Date

---

## SECTION 7: WHAT-IF SCENARIOS

### Candidate Withdraws Application
- Status in pipeline updates to **Withdrawn**
- No action needed from Recruiter — candidate is removed from active pipeline
- Requisition remains open for other candidates
- Withdrawn candidates can be viewed in the **All** candidate view (not just active)

### Candidate Declines Interview
- Recruiter receives notification
- Return to Interview Scheduling → offer a new time slot
- Or move candidate to a different status if they are no longer being considered

### Offer Declined by Candidate
- Status updates to **Offer Declined**
- Recruiter can re-open the pipeline for the requisition
- Previous candidates can be reconsidered by moving them back through the pipeline
- A new offer process can be initiated for a different candidate

### Approver Unavailable / Not Responding
- Recruiter or Admin can add an **Adhoc Approver** to the chain via the requisition
- Alternatively, use **Proxy** to log in as the approver and approve on their behalf (confirm this is permitted under your process)
- Escalation path: Admin Center → Recruiting → Approval Workflow → reassign approver

### Requisition Needs to be Cancelled
1. Open the Job Requisition
2. Click **Action → Close Requisition** or **Cancel Requisition**
3. Select a reason (e.g. Role no longer required, Hired internally)
4. Confirm — all active candidate applications will be marked accordingly

### Position Created in Error
1. Navigate to Position Org Chart
2. Find the position → click **Action**
3. Select **Make Position Inactive** or **Delete** (if no requisitions have been raised against it)
4. Note: positions with active requisitions cannot be deleted — close the requisition first

### Duplicate Candidate Application
- Candidates who apply more than once will appear as duplicates in the pipeline
- Recruiter can merge duplicate profiles: open one profile → **Action → Merge Candidate**
- Keep the most complete profile as the primary record

### Candidate Not Receiving Emails
1. Check the candidate's email address is correct on their profile
2. Confirm the email notification template is active: Admin Center → Email Notification Templates → Recruiting
3. Ask the candidate to check spam/junk folders
4. Check the sending domain is allowlisted with the candidate's email provider

### Requisition Approval Stuck / No Approver Receiving Notification
1. Check the approval chain is correctly configured: Admin Center → Recruiting → Manage Approval Workflows
2. Verify all approvers have active accounts and correct permissions
3. Check the approver's email is correct on their user profile
4. Proxy as the approver → check their home page for pending approval tiles

---

## SECTION 8: COMMON ERROR MESSAGES

| Error | Likely Cause | Fix |
|-------|-------------|-----|
| "You do not have permission to access this page" | Missing RBP permission | Admin Center → Manage Permission Roles → add required permission |
| "Required field missing" on requisition | Mandatory field left blank | Check all highlighted fields are completed |
| "No positions available" when creating requisition | Position not created or not linked to user's org unit | Create position first via Position Org Chart |
| "Approver not found" in approval chain | Approver account inactive or not set up | Verify approver's user account is active |
| "Offer letter token not resolved" | Field mapped to token is blank | Complete the missing field on requisition or offer form |
| "Candidate already exists" | Duplicate email address on application | Merge duplicate profiles or advise candidate to log in with existing account |
| "Interview slot no longer available" | Slot was booked by another process | Add a new custom slot via Interview Scheduling |
| "Unable to post job — no active channel" | Posting channel not configured | Admin Center → Recruiting → Posting Channel Configuration |
| "Position is inactive" | Position was deactivated | Reactivate position in Position Org Chart before raising requisition |

---

## SECTION 9: REPORTING & ANALYTICS

### Recruiting Dashboard
**Navigation:** Module Picker → Recruiting → Recruiting Dashboard (or Analytics)

Key metrics available out of the box:
- Open requisitions by status
- Time to fill (days from requisition creation to hire)
- Time to hire (days from application to offer accepted)
- Applications by source (career site, LinkedIn, referral, etc.)
- Pipeline conversion rates (applications → screened → interviewed → offered → hired)
- Offer acceptance rate
- Active candidates by stage

### How to Run a Recruiting Report
**Navigation:** Module Picker → Analytics → Report Centre

1. Click **Create Report** or select from existing templates
2. Select **Recruiting** as the subject area
3. Choose fields: Req ID, Job Title, Candidate Name, Status, Application Date, Hire Date, etc.
4. Apply filters (date range, department, location, recruiter)
5. Click **Run Report**
6. Export to Excel or CSV

### Key Standard Report Templates
| Report | What it Shows |
|--------|--------------|
| Requisition Summary | All open/closed requisitions with status and dates |
| Candidate Pipeline | All candidates across all requisitions with current status |
| Time to Fill | Average days from req creation to hire by department/location |
| Offer Report | All offers issued, accepted, declined, pending |
| Application Source Report | Where candidates are coming from |
| EEO / Diversity Report | Candidate demographics (if data collected) |

---

## SECTION 10: ONBOARDING INTEGRATION

### What Happens When a Candidate is Moved to Hired
When the Recruiter moves a candidate to **Hired** status (RCM-RC-116):
1. A **New Hire record** is created in SAP SuccessFactors
2. If SAP SuccessFactors Onboarding is configured, an **Onboarding task** is automatically triggered
3. The new hire receives a welcome email with onboarding portal access
4. Key data flows from RCM to Onboarding:
   - Full Name
   - Job Title
   - Department
   - Location
   - Start Date
   - Hiring Manager
   - Contract Type

### What Data Must Be Complete Before Moving to Hired
- Candidate legal name confirmed
- Start Date entered on offer form
- Department and Location set on requisition
- Contract Type selected on offer

### If Onboarding Does Not Trigger
1. Check Onboarding module is active and licensed
2. Verify the integration between RCM and Onboarding is configured: Admin Center → Onboarding → RCM Integration Settings
3. Confirm the Hired status is mapped to the Onboarding trigger in workflow configuration
4. Check the new hire record was created: Admin Center → Manage New Hires

---

## SECTION 11: DATA PRIVACY & COMPLIANCE

### Data Privacy Consent Statement (DPCS)
- Must be presented to candidates before any personal data is collected
- Configured in Career Site Builder → Privacy Statement
- Must be accepted by candidate before account creation completes
- Consent is logged with timestamp for audit purposes

### Candidate Data Retention
- Candidate data should be retained only for as long as legally required
- Configure retention periods: Admin Center → Data Retention Management
- Candidates who do not progress to hire should be anonymised or deleted after the retention period
- Candidates can request deletion of their data via the candidate portal (Right to Erasure — GDPR)

### Audit Trail
- All status changes, approvals, and actions in RCM are logged
- Accessible via Admin Center → Audit Trail
- Key events logged: requisition approval, candidate status changes, offer approvals, hire decisions

---

## SECTION 12: POSITION MANAGEMENT — ADVANCED

### Position Fields Reference

| Field | Description | Mandatory |
|-------|-------------|-----------|
| Position Title | Name of the position | Yes |
| Position Code | Unique identifier (auto-generated or manual) | Yes |
| Department | Linked org unit | Yes |
| Location | Office/site | Yes |
| Cost Centre | Finance code | Recommended |
| Job Classification | Job family / job role | Optional |
| FTE | Full Time Equivalent (1.0 = full time) | Optional |
| Incumbent | Current person in the role (for filled positions) | Optional |
| Reports To | Parent position in org chart | Yes |
| Status | Active / Inactive | Yes |

### Position Statuses
| Status | Meaning |
|--------|---------|
| Active | Position exists and can have requisitions raised against it |
| Inactive | Position exists but cannot be recruited for |
| Frozen | Position is on hold — no recruitment activity permitted |

### How to Make a Position Inactive
1. Position Org Chart → find position
2. Click **Action → Edit**
3. Change **Status** field to **Inactive**
4. Save

### How to Reactivate a Position
1. Position Org Chart → search for inactive positions (toggle filter to show inactive)
2. Click **Action → Edit**
3. Change **Status** to **Active**
4. Save

---

## SECTION 13: INTERVIEW SCHEDULING — ADVANCED

### Interview Types
| Type | Description |
|------|-------------|
| Phone | Phone call — no room booking required |
| Virtual | Video call (Teams, Zoom, etc.) — link shared via email |
| Face-to-Face | In-person — room booking may be required |
| Panel | Multiple interviewers — each must be added to the scheduling |

### How to Add Multiple Interviewers
1. Interview Scheduling → Find Req ID tile
2. Click **Add Interviewer** → add each panel member
3. Click **Find Availability** — system finds common availability across all interviewers
4. Select a slot that works for all → Send to candidate

### How to Reschedule an Interview
1. Navigate to Interview Scheduling → find the booked interview
2. Click **Reschedule**
3. Select a new slot → send updated invitation to candidate
4. Candidate receives new confirmation email

### How to Cancel an Interview
1. Interview Scheduling → find the booked interview
2. Click **Cancel Interview**
3. Candidate receives cancellation notification
4. Recruiter must then reschedule or move candidate to a different status

---

## SECTION 14: CANDIDATE PORTAL REFERENCE

### What Candidates Can Do in the Candidate Portal
- Create and manage their account
- Search and apply for jobs
- Track application status
- View and confirm interview times
- View, accept, or decline offer letters
- Download offer letter PDF
- Update personal details
- Withdraw an application
- Request data deletion (GDPR)

### Candidate Account Creation Requirements
- Valid email address (used as username)
- Password (minimum 8 characters, 1 uppercase, 1 number)
- DPCS consent accepted
- Email verification completed (link sent to inbox)

### How a Candidate Resets Their Password
1. Career site login page → click **Forgot Password**
2. Enter email address → receive reset link
3. Click link → enter new password
4. Log back in with new credentials

If reset email is not received: check spam, verify email address is correct on the account, or contact recruiter to confirm account exists.
