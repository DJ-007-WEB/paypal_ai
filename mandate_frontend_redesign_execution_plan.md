# Mandate Frontend Redesign --- Detailed Execution Plan

**Project:** Mandate --- AI-assisted procurement and purchasing control\
**Repository:** `DJ-007-WEB/paypal_ai`\
**Frontend:** React + Vite\
**Backend:** Node.js + Express\
**Persistence:** MongoDB\
**Document type:** Design and implementation specification\
**Status:** Proposed plan --- implementation must begin with a codebase
audit

------------------------------------------------------------------------

## 1. Executive direction

Mandate should feel like a **serious, contemporary financial-operations
product with a distinctive editorial identity**---not a generic SaaS
admin template, not a generic AI dashboard, and not a neon "AI future"
concept.

The interface should communicate that procurement decisions have
consequences. It should be calm enough for repeated daily use,
distinctive enough to be memorable, and explicit about how
recommendations, policy checks, and human authorization differ.

### The product rule that governs every screen

1.  **AI recommends.**
2.  **Deterministic policy logic validates.**
3.  **An authorized human makes the approval decision.**
4.  **Payment execution remains unavailable unless a separately
    implemented and authorized workflow explicitly enables it.**

Do not blur these responsibilities in visual language, button labels,
status badges, or animations. A recommendation is not an approval; a
successful validation is not a payment; and a preview is not a persisted
import.

### What the redesign must achieve

-   Give the product a recognizable visual identity that avoids generic
    green procurement branding.
-   Make typography, hierarchy, and density comfortable at normal
    desktop sizes.
-   Give every page a coherent application shell and predictable
    navigation.
-   Make vendor import feel like a polished, robust data workflow---not
    a cramped form.
-   Make purchase comparisons and policy outcomes easy to scan and
    understand.
-   Provide genuinely usable light, dark, and system themes.
-   Use restrained motion only where it improves orientation or
    feedback.
-   Preserve existing business logic and working API calls.
-   Make errors, loading, empty, offline, partial-success, and locked
    states intentional.
-   Keep the interface honest about which features are implemented and
    which are unavailable.

------------------------------------------------------------------------

## 2. Design concept: "The Decision Ledger"

The proposed design concept is **The Decision Ledger**: a blend of
editorial financial software, modern industrial procurement, and a
well-typeset operations journal.

It should feel closer to a thoughtfully designed financial terminal or
premium B2B finance tool than to a generic dashboard kit. It should not
imitate a stock-trading terminal with tiny type and excessive data, nor
should it become a luxury brand website that sacrifices operational
clarity.

### Visual characteristics

-   Warm, paper-like light surfaces rather than pure white everywhere.
-   Ink-dark text and deep plum/navy structural elements.
-   A memorable **persimmon/coral accent** for primary actions and key
    interaction cues.
-   A restrained cobalt/blue secondary accent for informational states
    and navigation details.
-   Neutral, carefully separated surfaces; thin borders instead of heavy
    shadows.
-   Large, confident page headings; readable body copy; compact but
    legible metadata.
-   Strong numerical alignment for prices, quantities, budgets, and
    scores.
-   Clear table structure and generous row height.
-   Sparse graphic motifs inspired by ledger lines, document tabs, folio
    numbers, and procurement records.
-   No decorative AI sparkles, glowing gradients, glassmorphism,
    animated blobs, or gratuitous illustrations.

### Color is not decoration

Use color to convey structure and meaning. A primary action should be
visually distinct, but it must not resemble a success state. Error,
warning, success, informational, selected, disabled, and locked states
must remain distinguishable in both themes.

The proposed palette is a starting point, not a substitute for contrast
testing. Adjust exact values when accessibility checks show a failure.

------------------------------------------------------------------------

## 3. Proposed visual system

### 3.1 Light theme

  ------------------------------------------------------------------------
  Token                   Starting value          Purpose
  ----------------------- ----------------------- ------------------------
  `--bg`                  `#F4F0E8`               Warm chalk canvas

  `--surface`             `#FFFCF7`               Main cards and panels

  `--surface-raised`      `#FFFFFF`               Menus, popovers, raised
                                                  dialogs

  `--text`                `#211D29`               Primary text, a deep
                                                  ink-plum

  `--text-secondary`      `#625D68`               Supporting text

  `--text-muted`          `#77717B`               Metadata; only where
                                                  contrast remains
                                                  sufficient

  `--border`              `#DCD5CB`               Dividers and component
                                                  outlines

  `--primary`             `#C94F35`               Persimmon primary action

  `--primary-hover`       `#A83C28`               Hover/pressed primary
                                                  action

  `--primary-soft`        `#F6E2DA`               Selected/action-tinted
                                                  surfaces

  `--secondary-accent`    `#4058B8`               Informational emphasis
                                                  and selected navigation
                                                  details

  `--secondary-soft`      `#E7EAF8`               Informational background

  `--success`             `#286747`               Positive status only

  `--warning`             `#8B571C`               Warnings and attention
                                                  required

  `--danger`              `#AD342E`               Errors and
                                                  rejected/failed states

  `--focus`               `#4058B8`               Keyboard focus indicator
  ------------------------------------------------------------------------

### 3.2 Dark theme

  Token                  Starting value   Purpose
  ---------------------- ---------------- -----------------------------------
  `--bg`                 `#17151C`        Deep plum-charcoal canvas
  `--surface`            `#211E27`        Main panels
  `--surface-raised`     `#2A2631`        Menus, popovers, dialogs
  `--text`               `#F3EEE8`        Primary text
  `--text-secondary`     `#C0B8C4`        Supporting text
  `--text-muted`         `#A49AA8`        Metadata where contrast passes
  `--border`             `#413946`        Dividers and outlines
  `--primary`            `#F08062`        Primary action
  `--primary-hover`      `#FF9A7F`        Hover/pressed primary action
  `--primary-soft`       `#442C2A`        Selected/action-tinted surfaces
  `--secondary-accent`   `#A5B2FF`        Informational emphasis
  `--secondary-soft`     `#2B2F49`        Informational background
  `--success`            `#8ED0A5`        Positive status only
  `--warning`            `#E8BB77`        Warnings and attention required
  `--danger`             `#FF958D`        Errors and rejected/failed states
  `--focus`              `#A5B2FF`        Keyboard focus indicator

**Important:** These are candidate values. Verify actual
foreground/background pairs against WCAG contrast requirements. Do not
assume a color passes because it looks readable on one monitor.

### 3.3 Theme behavior

Implement three user-facing choices:

-   **Light**
-   **Dark**
-   **System**

Requirements:

-   Persist the explicit choice in local storage.
-   Resolve `System` from `prefers-color-scheme`.
-   Update when the operating-system preference changes while `System`
    is selected.
-   Set the theme before the React UI paints where practical to avoid a
    flash of the wrong theme.
-   Use semantic CSS variables throughout the app. Components should not
    hard-code light-theme colors.
-   Ensure forms, file inputs, dropdowns, tables, badges, charts,
    overlays, and browser-native controls remain readable in both
    themes.
-   Use a labeled control; do not make an icon-only toggle the sole
    indication of current mode.
-   Test theme persistence after reload and navigation.
-   Include reduced-motion behavior independently of theme.

### 3.4 Typography

Use **Inter** as the primary interface typeface, with a system
sans-serif fallback. Avoid mixing several display fonts without a clear
purpose.

  ------------------------------------------------------------------------
  Element                                Target size Notes
  --------------------- ---------------------------- ---------------------
  Main page heading                        32--38 px Strong, compact line
                                                     height

  Landing hero heading          48--64 px responsive Editorial scale, not
                                                     oversized on mobile

  Section heading                          23--28 px Clear section
                                                     hierarchy

  Card heading                             18--22 px Avoid tiny card
                                                     titles

  Body copy                                15--16 px Default operational
                                                     reading size

  Form labels                              14--15 px Medium weight, clear
                                                     spacing

  Table body                               14--15 px Do not sacrifice
                                                     legibility for
                                                     density

  Supporting text                          13--14 px Use sparingly and
                                                     maintain contrast

  Metadata/eyebrows                        11--12 px Never use as the only
                                                     important explanation

  Large currency value                     28--36 px Tabular numerals and
                                                     consistent alignment
  ------------------------------------------------------------------------

Use `font-variant-numeric: tabular-nums` for currency, counts, IDs where
appropriate, quantities, and scores. Align currency values to the right
in comparison tables. Use sentence case for most labels; reserve
uppercase, letter-spaced text for small section markers.

### 3.5 Spacing, borders, and shape

-   Use a consistent spacing scale based on 4 px: 4, 8, 12, 16, 20, 24,
    32, 40, 48, 64.
-   Default page content padding: 28--36 px on desktop, 18--24 px on
    tablet, 14--18 px on mobile.
-   Prefer 8--12 px corner radii for cards and inputs; avoid excessive
    pill shapes.
-   Use thin borders to define structure.
-   Avoid stacking borders, shadows, and tinted backgrounds on the same
    component without a reason.
-   Use shadows only for elevation changes such as menus, dialogs, and
    popovers.
-   Use a consistent 44 px minimum height for primary interactive
    controls when practical.

------------------------------------------------------------------------

## 4. Product and architecture constraints

The UI redesign must not quietly replace product behavior with visual
mockups.

### Existing stack to preserve

-   React and Vite frontend.
-   Node.js and Express backend.
-   MongoDB persistence where implemented.
-   Existing API client and server request/response contracts.
-   Existing purchase evaluation and policy-validation flow.
-   Existing spreadsheet parsing and vendor-import API integration.

### First step: audit before coding

Before changing components, inspect the current `main` branch and
confirm the real state of:

-   `frontend/src/App.jsx`
-   `frontend/src/styles.css`
-   `frontend/src/api/client.js`
-   `frontend/src/main.jsx`
-   `frontend/index.html`
-   `frontend/package.json`
-   Backend vendor, purchase, policy, audit, and workspace
    routes/services
-   Current data model fields and API response shapes

The repository has had earlier changes that may not be fully reflected
in every screen. Do not trust old UI copy that claims an API is missing
until the current backend has been inspected. Conversely, do not claim
an API persists something until a real request and database read verify
it.

### Non-negotiable data rules

-   Do not invent dashboard totals or supplier metrics.
-   Do not display fake vendor offers as if they were imported from the
    user.
-   Do not label a client-side spreadsheet preview as an import.
-   Do not show "saved" until the server confirms the write.
-   Do not show "approved" unless a real approval workflow records that
    decision.
-   Do not show "paid" unless payment execution exists and confirms the
    transaction.
-   Do not present sample/illustrative values as real workspace data.
-   If the API is unavailable, show an honest empty/offline/error state.
-   Keep sample data in explicit fixtures or seed files, separate from
    production code paths.
-   Preserve the central boundary: recommendation → deterministic
    validation → human decision. Payment execution remains locked unless
    genuinely implemented and authorized.

### Interaction and routing

-   Inspect every current route and link before restructuring
    navigation.
-   Keep all existing working destinations accessible.
-   Do not add navigation items that lead to placeholder pages without
    labeling the limitation.
-   If a feature is unavailable, provide an honest explanation and a
    relevant next action.
-   Preserve browser back/forward behavior.
-   Avoid adding a routing dependency unless the audit shows a clear
    need and the change is worth the risk.

------------------------------------------------------------------------

## 5. Information architecture and app shell

The logged-in application should have a stable shell with a clear
hierarchy.

### Proposed primary navigation

1.  **Overview**
2.  **Purchase desk**
3.  **Purchase history**
4.  **Supplier catalog**
5.  **Import suppliers**
6.  **Policy controls**
7.  **Audit trail**
8.  **Workspace settings**

Only expose **Approvals** as a primary destination if there is a
meaningful review queue or a clearly explained not-yet-available state.
Do not make an empty placeholder look operational.

Team management should be nested under workspace settings unless role
management is a core, implemented workflow.

### App shell layout

**Left sidebar** - Brand mark and product name. - Current workspace
identity. - Primary navigation grouped by workflow. - Clear active-route
treatment. - Bottom area for account and environment status. - Mobile
drawer with proper focus and close behavior.

**Top header** - Breadcrumb/current page title. - API/connectivity
status only when it is genuinely checked. - Theme control. -
User/workspace menu if the underlying functionality exists.

**Main content** - Consistent maximum width or fluid layout chosen for
each page type. - Page title, concise explanation, and one primary
action. - Content sections with clear separation. - Responsive tables
that remain usable rather than shrinking into unreadable columns.

**Footer** - Keep unobtrusive. Show prototype/payment limitations only
where useful; do not repeat large warning banners on every screen.

### Responsive behavior

-   Desktop: persistent sidebar.
-   Tablet: compact or collapsible sidebar with full content width.
-   Mobile: drawer navigation and stacked page sections.
-   Tables: horizontal scrolling or deliberate card conversion, not
    arbitrary clipping.
-   Forms: single column on narrow screens.
-   Import preview: horizontal scroll with sticky row/column context
    where feasible.
-   Dialogs and menus: fit within viewport and remain keyboard
    accessible.

------------------------------------------------------------------------

## 6. Screen-by-screen redesign specification

## 6.1 Public landing page

### Goal

Explain Mandate in seconds: what it does, who it helps, and why its
controls matter.

### Layout

1.  **Navigation bar**
    -   Brand on the left.
    -   A small set of anchor links, such as Product, Workflow, and
        Controls.
    -   Log in and primary call to action on the right.
    -   Collapse secondary links on mobile.
2.  **Hero**
    -   Eyebrow: concise product category.
    -   One clear headline about better purchasing decisions and
        controlled spend.
    -   One short paragraph.
    -   Primary CTA and quieter secondary link.
    -   A carefully composed product preview on the opposite side.
3.  **Product preview**
    -   Use a truthful illustrative request with a visible "Illustrative
        preview" label.
    -   Show supplier comparison, total cost, delivery, and policy
        outcome.
    -   Explicitly separate "Recommendation" from "Human review
        required."
    -   Do not make the preview appear to be live user data.
4.  **Three-step workflow**
    -   Define request.
    -   Compare and validate.
    -   Review the recommendation.
5.  **Control principles**
    -   Recommendations are advisory.
    -   Policy checks are deterministic.
    -   Humans retain approval authority.
    -   Payment execution is not enabled in the prototype.
6.  **Closing CTA and footer**
    -   Keep the message specific.
    -   Avoid generic claims such as "Revolutionizing procurement with
        AI."
    -   Do not invent customer logos, testimonials, compliance
        certifications, or performance statistics.

### Landing page visual direction

Use a strong type-led hero, editorial spacing, and a well-composed
interface preview. Avoid a generic gradient orb, robot imagery,
sparkles, stock photos of businesspeople, or a row of fake partner
logos.

------------------------------------------------------------------------

## 6.2 Authentication and entry

### Requirements

-   Clearly distinguish sign-in from workspace creation.
-   Use readable labels, helpful validation, and accessible password
    controls.
-   Keep errors adjacent to the field or form that caused them.
-   Loading states must prevent accidental duplicate submission.
-   Never imply secure server authentication if the current flow is
    client-side demo access.
-   If backend authentication is implemented, connect the UI to the
    actual auth API and display real server errors.
-   If not implemented, explicitly label the flow as prototype/demo
    access and never encourage use of a real password.
-   Do not add a fake password-reset workflow that appears to send an
    email.

### Visual structure

-   Desktop: split layout only if the secondary panel provides useful
    product context.
-   Mobile: form first; hide decorative copy before compressing the
    form.
-   Form width around 400--480 px.
-   Clear field spacing and a visible focus state.
-   No unnecessary social-login buttons unless they work.

------------------------------------------------------------------------

## 6.3 Workspace setup

The current onboarding includes business details, procurement defaults,
approval preferences, vendor import, and a review step. Keep the
sequence understandable, but do not let it become a long, crowded form.

### Recommended wizard pattern

-   A visible step indicator with labels and current-step state.
-   A single focused panel for the current task.
-   Back and Continue actions in a consistent footer.
-   Field-level errors and a summary when several errors exist.
-   Preserve entered data when navigating between steps.
-   Allow vendor import to be skipped and completed later.
-   On the final step, show what is actually saved locally versus sent
    to the backend.

### Step 1: Business profile

Group fields into identity and contact information. Do not make optional
contact fields look required. Use sensible defaults only when they are
true defaults, and distinguish defaults from persisted organization
settings.

### Step 2: Procurement defaults

Use numeric controls with range validation and explanatory helper text.
Make currency explicit. Explain that defaults prefill a request; do not
claim they are server-enforced policy unless the backend enforces them.

### Step 3: Review preferences

Clearly identify preference versus enforced permission. If approval
preferences are only stored locally, say so and do not imply that they
grant roles or authority.

### Step 4: Import suppliers

Use the full import workflow in Section 6.5. The wizard should use the
same component as the standalone Import Suppliers page rather than a
separate, divergent implementation.

### Step 5: Review and finish

Summarize profile and defaults in readable groups. Distinguish: - Saved
to this browser. - Persisted by the server. - Previewed but not
imported. - Successfully imported. - Not configured.

The final action label must accurately describe what it does. If it only
completes local setup, do not label it "Create organization" in a way
that implies a server-side organization record.

------------------------------------------------------------------------

## 6.4 Overview dashboard

### Goal

Provide a trustworthy summary of the current workspace and useful next
actions---not a decorative wall of metrics.

### Content priority

1.  Welcome/title row and concise workspace context.
2.  One primary next action, usually "New purchase request."
3.  Real operational summary, but only for data available from actual
    endpoints.
4.  Recent purchase evaluations or latest activity if the backend
    provides them.
5.  Setup progress only when it reflects real, persisted configuration.
6.  Clear empty states when no purchase history or catalog data exists.

### Metrics

Only display counts and totals that can be calculated from current, real
data. Each metric needs a clear definition and data source. Do not
display fabricated spend saved, approval rates, vendor counts, or
performance percentages.

If there is no list/history endpoint, replace a fake "Recent purchases"
panel with an honest action-oriented empty state or a compact
explanation of what can be done next.

### Layout

-   A prominent action or compact summary area.
-   Two or three meaningful content panels, not six identical metric
    cards.
-   Use large numbers sparingly.
-   Keep text large enough to read.
-   Do not use a chart unless the data exists and the chart supports a
    real decision.

------------------------------------------------------------------------

## 6.5 Import Suppliers --- highest-priority workflow redesign

The import workflow deserves a dedicated design pass because it combines
file selection, column mapping, data validation, tabular inspection, and
a consequential database write.

### Page layout

**Page header** - Title: "Import suppliers" - One-sentence
explanation. - Optional link to a sample template only if the
downloadable template actually exists. - Show supported file formats and
file-size limit near the upload control.

**Step indicator** 1. Upload 2. Map columns 3. Review data 4. Import 5.
Results

Keep current step and completed steps visually distinct. Do not use
color alone to indicate status.

### Stage 1 --- Upload

-   Large but restrained dropzone with a clear border and simple
    file/document icon.
-   Primary instruction: "Drop a supplier spreadsheet here."
-   Secondary action: "Browse files."
-   Supported extensions and maximum size visible.
-   Accepted file state displays filename, file size, detected worksheet
    count, and remove/replace action.
-   Drag-over state should change border/background subtly, not flash or
    glow.
-   Loading state should say "Reading spreadsheet..." and prevent
    repeated file handling.
-   Error state should explain unsupported format, size limit,
    unreadable workbook, or empty worksheet separately.

### Stage 2 --- Map columns

Use a two-column mapping layout on wide screens and one column on
mobile.

Required mappings should be visibly marked. Optional fields must be
clearly labeled as optional. Provide a "Not mapped" option and show
which required fields remain unmapped.

Suggested required field groups: - Supplier identity: supplier/vendor
name and ID. - Offer identity: product/SKU. - Pricing: currency and unit
price. - Availability: available quantity and delivery days. - Controls:
approved status, quality score, reliability score.

Shipping, tax, and fees need explicit semantics. If omitted, the product
must apply a documented rule (such as zero) only when the backend
contract permits it. Do not silently interpret a blank value as zero if
that could change the purchase decision.

Mapping logic must be tested against real column names, including: -
`vendorName`, `vendorId`, `productId` - `currency`, `unitPrice`,
`unitPriceMinor` - `availableQuantity`, `quantity`, `stock` -
`deliveryDays`, `leadTime` - `shipping`, `shippingMinor`, `tax`,
`taxMinor`, `fees`, `feesMinor` - `vendorApproved`, `approved`,
`status` - `qualityScore`, `reliabilityScore` - Optional contact email
and website

**Currency conversion must be explicit.** If spreadsheet monetary values
are in major currency units, convert them once to minor units for the
API. If columns are already minor-unit fields, do not multiply by 100
again. Use the header mapping or a clear user choice to disambiguate.
Test decimal values, integer values, zero charges, and currencies with
different minor-unit conventions before broadening supported currencies.

### Stage 3 --- Review data

This stage must be a proper data-review surface, not a tiny five-column
table squeezed into a form.

Display: - Total rows detected. - Valid rows. - Invalid rows. -
Duplicate identifiers. - Required fields still unmapped. - A table with
horizontal scrolling and a readable minimum width. - A clear status
column showing valid, warning, or invalid. - Row numbers and
human-readable validation messages.

Use column headers that stay legible. Show enough columns to make review
useful, with a visible way to inspect the full row. On mobile,
horizontal scrolling is preferable to hiding essential values.

Validation examples: - Missing supplier ID or name. - Missing
product/SKU. - Unsupported currency. - Non-numeric, negative, or
malformed price. - Invalid quantity. - Invalid delivery-day value. -
Quality/reliability score outside permitted bounds. - Invalid approval
status. - Duplicate supplier/product combination. - Missing optional
charges where the data contract requires them.

Do not report a row as valid solely because it can be parsed. Validate
semantic constraints.

### Stage 4 --- Import confirmation

Before writing: - Show the number of rows to be imported. - Show the
number of rows rejected or requiring correction. - Explain whether the
import will create new offers, update existing offers, or both. -
Explain the duplicate/upsert key. - Require an explicit confirmation
action for the write. - Disable the action while the request is in
flight. - Prevent accidental repeated submissions where possible.

The user must understand that this action writes to the backend
database.

### Stage 5 --- Results

Handle these cases distinctly: - Full success. - Partial success, if the
backend supports partial results. - Validation rejection. - Network
failure. - Server error. - Import conflict or duplicate update. -
Unknown response shape.

Show the backend's actual result counts and messages. Do not hard-code
success counts. On failure, preserve the uploaded file and mapping so
the user can correct and retry.

After success: - Show what was persisted. - Provide a next action such
as "Open supplier catalog" or "Evaluate a purchase." - Refresh catalog
data from the backend if a catalog endpoint exists. - Never show a
success message based only on the frontend finishing its request
handler.

### Implementation strategy

Create one reusable import component/state machine shared by onboarding
and the standalone Import Suppliers route. Avoid maintaining two
independent import implementations.

Suggested component boundaries: - `VendorImportWizard` -
`FileDropzone` - `ColumnMappingForm` - `ImportValidationSummary` -
`SpreadsheetPreviewTable` - `ImportConfirmation` - `ImportResultPanel`

These are suggested boundaries, not a mandate to create one file per
component. Keep abstractions proportionate and readable.

------------------------------------------------------------------------

## 6.6 Supplier catalog

### Goal

Show the supplier offers that the system actually knows about, and make
their origin and state clear.

### Layout

-   Header with "Supplier catalog," concise description, and "Import
    suppliers" action.
-   Search and filters only if the API supports them or they can be
    accurately implemented client-side over loaded data.
-   Table or structured list with supplier, SKU, unit price, additional
    charges, total-cost context, available quantity, delivery, approval,
    quality, reliability, and active status where available.
-   Use consistent alignment and tabular numerals.
-   Clearly distinguish supplier-level fields from offer-level fields.

### Empty and error states

-   Empty: explain how to import offers.
-   Loading: skeleton rows that match the real table structure.
-   Offline/error: clear status and retry action.
-   Populated: display only data returned by the backend.

Do not label a static catalog "live." Do not present a seeded fixture as
an actual supplier import. Do not add editing controls unless update
APIs exist and are tested.

------------------------------------------------------------------------

## 6.7 Purchase desk

### Goal

Help a user define a request, compare offers, understand why an offer
was selected, and see exactly what remains for human review.

### Form structure

Group fields into: 1. Product and quantity. 2. Budget and currency. 3.
Delivery constraints. 4. Quality and reliability thresholds. 5. Supplier
approval requirements.

Use labels that explain the unit and scope. Validate numbers before
submission. Preserve the form after errors. Do not clear a valid request
when the API fails.

### Decision result hierarchy

**Recommendation panel** - Status: recommendation available or no
eligible offer. - Supplier and offer ID. - Unit price and total cost,
with explicit inclusion of shipping/tax/fees when the backend provides
them. - Quantity available. - Delivery estimate. - Quality/reliability
scores. - Why it was recommended, if the backend returns defensible
reasons. - Clear note that this is not approval.

**Policy checks panel** - Passed/failed/unknown status for each actual
check. - The constraint and result in readable language. - No fabricated
check results. - Do not show a green check merely because the request
returned HTTP 200.

**Human decision panel** - Explicitly show "Human review required" or
the actual backend state. - Keep approval separate from
recommendation. - If approval endpoints are not implemented, show
"Approval workflow not connected" rather than a button that appears to
approve.

**Payment boundary** - State that payment execution is locked/not
enabled in this prototype. - Never include a "Pay now" action unless a
fully implemented and authorized payment flow exists.

### Comparison table

Show eligible and rejected offers separately or provide an accessible
filter between them. For rejected offers, include reasons if the backend
returns them. Make the recommended offer easy to locate without
obscuring alternatives.

Recommended fields: - Supplier/offer. - Total cost. - Delivery. -
Quantity availability. - Approval state. - Quality/reliability. -
Eligibility and reason.

Do not sort only by lowest unit price if total cost, delivery, stock, or
policy constraints determine the outcome.

### Error-state taxonomy

Do not collapse all failures into "Something went wrong."

Differentiate: - Request validation error. - No eligible offers. -
Policy failure. - API unreachable. - Server-side evaluation error. -
Malformed/unknown response.

Explain what the user can do next. Do not describe an API/network
failure as a policy rejection.

------------------------------------------------------------------------

## 6.8 Purchase history

Build this page around real purchase records and actual list/detail
endpoints.

If only lookup-by-ID is supported, do not fake a history table. Present
a clear lookup form and explain that searchable history requires a list
endpoint. If a history endpoint is implemented, include date, purchase
ID, product, quantity, requested budget, recommendation status, and
current authorization status where available.

Use pagination or progressive loading if record volume requires it.
Never infer a final purchase or payment from a recommendation record.

------------------------------------------------------------------------

## 6.9 Policy controls

Separate **configured preferences** from **enforced policy**.

Display each control with: - Name. - Current value. - Scope. - Whether
it is a local preference or server-enforced rule. - Where the rule is
evaluated. - Last saved status if a real persistence endpoint exists.

If the current backend accepts constraints as part of each purchase
request, describe them as request constraints unless the backend has a
separate persisted policy model. Do not imply that changing a local
onboarding preference changes backend enforcement.

Editing should only be enabled when a save endpoint exists and has been
tested. Otherwise show read-only details with honest prototype
messaging.

------------------------------------------------------------------------

## 6.10 Audit trail

Display events only from the actual audit endpoint.

Each event should show: - Timestamp with a readable timezone. - Event
type. - Actor or system component where available. - Related
purchase/offer identifier. - Outcome. - Details or expandable metadata
where useful.

Use a compact timeline or table with filters only if the data and APIs
support them. Include a useful empty state. Do not synthesize events in
the UI to fill the page. Do not imply immutability or compliance
certification unless the system genuinely provides it.

------------------------------------------------------------------------

## 6.11 Workspace settings

Organize settings into clear groups: - Business identity. - Currency and
procurement defaults. - Review preferences. - Account/team, only if
implemented. - Theme and interface preferences.

Use read-only summaries where the server cannot save changes. If some
settings are local and others server-persisted, label their persistence
separately.

Avoid displaying a large "Edit" action that leads to an unrelated wizard
without preserving context. Every control should have a clear outcome.

------------------------------------------------------------------------

## 7. Component system

Create a small, consistent design system before individually styling
every screen.

### Core primitives

-   `AppShell`
-   `SidebarNavigation`
-   `Topbar`
-   `Breadcrumbs`
-   `PageHeader`
-   `Button`
-   `IconButton` with accessible label
-   `TextField`
-   `SelectField`
-   `CheckboxField`
-   `StatusBadge`
-   `InlineAlert`
-   `EmptyState`
-   `LoadingState` / skeleton
-   `ConfirmDialog`
-   `DataTable`
-   `MoneyValue`
-   `ScoreValue`
-   `ThemeControl`

### Domain components

-   `VendorImportWizard`
-   `ColumnMappingForm`
-   `SpreadsheetPreviewTable`
-   `ImportResultPanel`
-   `PurchaseRequestForm`
-   `RecommendationPanel`
-   `PolicyCheckList`
-   `OfferComparisonTable`
-   `PurchaseStatusSummary`
-   `AuditEventList`

### Component behavior rules

-   Buttons must distinguish primary, secondary, quiet, destructive, and
    disabled states.
-   A disabled action should explain why it is disabled when the reason
    is not obvious.
-   Status badges must include text, not color alone.
-   Inputs need labels, error messages, and keyboard focus.
-   Tables need readable headers, row hover/selection only where useful,
    and an empty state.
-   Loading skeletons must resemble the eventual content.
-   Reuse domain components instead of copying slightly different markup
    into onboarding and standalone routes.

Do not build an elaborate component framework for its own sake. The
purpose is consistency and maintainability, not abstraction volume.

------------------------------------------------------------------------

## 8. Motion and interaction design

Motion should make a change easier to understand, not advertise that the
product is animated.

### Allowed motion

-   140--220 ms transitions for color, border, and background changes.
-   Small vertical movement on a button hover if it remains subtle.
-   Sidebar drawer slide-in/out.
-   Short fade/slide when a panel changes state.
-   Drag-over highlight on the file dropzone.
-   Progress indication during file parsing and import.
-   Clear success/error state transition after a server response.
-   Theme transition only if it does not cause a flash or impair
    readability.

### Avoid

-   Infinite animations.
-   Pulsing status dots unless the state genuinely indicates ongoing
    activity.
-   Glowing borders and neon gradients.
-   Floating blobs or particle backgrounds.
-   Large page transitions.
-   Animated numbers that obscure actual values.
-   Confetti for a database import.
-   Motion that causes layout shifts.

Respect `prefers-reduced-motion: reduce`. No essential information
should depend on an animation.

------------------------------------------------------------------------

## 9. Accessibility and usability requirements

Treat accessibility as a build requirement.

-   WCAG AA contrast: target at least 4.5:1 for normal text and 3:1 for
    large text and essential UI graphics.
-   Visible keyboard focus.
-   Full keyboard navigation for menus, drawers, dialogs, forms, and
    table actions.
-   Labels associated with inputs.
-   Error messages associated with their fields and announced where
    appropriate.
-   Use semantic buttons and links; do not use clickable `div` elements
    for controls.
-   Status must be communicated by text/icon plus color, not color
    alone.
-   Minimum practical touch target of about 44 × 44 px.
-   No horizontal page overflow at 320 px viewport width.
-   Tables must have a usable mobile strategy.
-   Dialogs must manage focus and close predictably.
-   Ensure screen readers can understand progress in the import flow.
-   Ensure focus is not lost when import results or form errors appear.
-   Do not use extremely small text for important details.

Test both themes; contrast failures often appear only in dark mode.

------------------------------------------------------------------------

## 10. Technical implementation plan

Use small, reviewable phases. Each phase must leave the app in a
buildable state.

### Phase 0 --- Baseline audit and capture

**Purpose:** establish what actually exists before changing the
interface.

Tasks: 1. Fetch the latest `main` and inspect the current file tree. 2.
Read the frontend entry point, main app, styles, API client, and package
manifest. 3. Map each route to its component and backend endpoints. 4.
Identify placeholder screens and stale claims about missing APIs. 5.
Identify duplicated import logic. 6. Identify hard-coded colors,
typography, and component-specific overrides. 7. Record current behavior
for purchase evaluation, import, navigation, auth/demo entry, and
settings. 8. Run the existing frontend build and record baseline
failures. 9. Capture desktop and mobile screenshots for key screens if
browser tooling is available. 10. Create a route/API truth table.

**Deliverables:** route map, API capability map, baseline build result,
list of high-risk regressions.

**Exit condition:** the implementation team can say which behaviors are
real, which are local-only, and which are placeholders.

### Phase 1 --- Design tokens and typography

Tasks: 1. Add semantic color tokens for light and dark. 2. Add
typography and spacing tokens. 3. Replace hard-coded colors in the
shared shell and common primitives. 4. Establish border, radius, and
elevation conventions. 5. Add focus, disabled, error, warning, success,
and selected states. 6. Add the theme initialization and preference
control. 7. Verify forms and tables in both themes.

**Exit condition:** switching theme changes the complete shared
interface without illegible components or flashes caused by React
initialization.

### Phase 2 --- Shared shell and navigation

Tasks: 1. Refine sidebar width, grouping, active route, and workspace
identity. 2. Refine topbar, breadcrumbs, and theme control. 3. Ensure
mobile drawer works with keyboard and touch. 4. Correct page padding and
max-width rules. 5. Remove redundant "DEMO" indicators where a clearer
prototype label already exists, but keep essential limitations visible.
6. Ensure every nav item leads to a meaningful route.

**Exit condition:** all routes share one stable, responsive shell.

### Phase 3 --- Shared components and states

Tasks: 1. Standardize buttons, fields, alerts, badges, cards, and
tables. 2. Add reusable empty, loading, error, and success states. 3.
Standardize money and score formatting. 4. Remove conflicting old CSS
rules rather than continually stacking overrides. 5. Add accessible
focus and reduced-motion behavior.

**Exit condition:** common components look and behave consistently.

### Phase 4 --- Import workflow

Tasks: 1. Build one reusable staged import workflow. 2. Correct the
hierarchy and spacing of upload and mapping screens. 3. Make preview
table readable at desktop and mobile widths. 4. Make mapping
required/optional semantics clear. 5. Validate rows before import and
explain invalid rows. 6. Verify money-unit conversion and field mappings
against the backend schema. 7. Confirm the exact import request payload.
8. Show real backend success/error results. 9. Preserve mapping and data
after recoverable failures. 10. Test repeated import/upsert behavior.
11. Update the catalog from the API after successful import if the
endpoint supports it. 12. Reuse the same workflow from onboarding and
the standalone route.

**Exit condition:** a real spreadsheet can be parsed, reviewed,
validated, submitted, and confirmed from the backend without misleading
UI states.

### Phase 5 --- Purchase desk and recommendation clarity

Tasks: 1. Improve form grouping and validation. 2. Improve loading,
API-disconnected, and evaluation-error states. 3. Redesign
recommendation summary and policy checklist. 4. Redesign offer
comparison table. 5. Explain rejected offers only using actual backend
response details. 6. Make human review and payment lock explicit. 7.
Test no-eligible-offer and policy-failure cases.

**Exit condition:** a user can understand the request, recommendation,
policy outcome, and next human action without confusing one state for
another.

### Phase 6 --- Dashboard, catalog, history, policies, audit, settings

Tasks: 1. Remove fabricated metrics and mock activity from user-facing
paths. 2. Wire each page to a real endpoint where one exists. 3. Use
useful, honest empty states where endpoints/data are absent. 4. Separate
local settings from server-persisted settings. 5. Align tables, headers,
cards, and status treatments across pages. 6. Verify links and actions.

**Exit condition:** every visible data point has a known source, and
every action does what its label promises.

### Phase 7 --- Landing, authentication, onboarding polish

Tasks: 1. Refine landing page message and product preview. 2. Keep
illustrative data visibly labeled. 3. Make authentication claims match
the real auth implementation. 4. Ensure onboarding state is preserved
between steps. 5. Reuse the supplier-import workflow. 6. Make the final
onboarding summary precise about what was saved and where. 7. Test
mobile layout.

**Exit condition:** public entry and setup communicate the product
accurately and feel like part of the same design system.

### Phase 8 --- Motion, responsive QA, accessibility, regression

Tasks: 1. Add only motion with a functional purpose. 2. Test
reduced-motion mode. 3. Test at 320, 390, 768, 1024, 1280, and 1440 px
widths. 4. Test all screens in light and dark modes. 5. Check keyboard
navigation and focus order. 6. Run contrast checks. 7. Test the full
vendor import flow. 8. Test purchase evaluation success,
no-eligible-offer, policy rejection, API failure, and retry. 9. Test
refresh, browser back/forward, and theme persistence. 10. Run frontend
build and relevant backend tests. 11. Inspect console/network errors.
12. Compare before/after screenshots for regressions.

**Exit condition:** no known blocker in the main flows; all unresolved
backend limitations are explicitly represented in the UI.

------------------------------------------------------------------------

## 11. Test plan and acceptance criteria

### Build and runtime

-   `npm run build` succeeds in `frontend`.
-   No React key warnings or unhandled runtime errors in primary flows.
-   No broken asset imports.
-   No missing CSS or route crashes.
-   API failures are caught and shown to the user.

### Theme

-   Light, dark, and system modes work.
-   Explicit preference persists after reload.
-   System mode follows operating-system preference changes.
-   All core screens remain legible in both themes.
-   No significant flash of the wrong theme on initial load.

### Import

-   Accepts only supported file types.
-   Enforces file-size limit.
-   Handles empty/unreadable spreadsheets.
-   Supports worksheet selection when multiple sheets exist.
-   Required mapping omissions are explained.
-   Invalid rows are identified with actionable reasons.
-   Monetary units are converted correctly and exactly once.
-   Import action is disabled during submission.
-   Backend failure does not produce success UI.
-   Successful import displays the actual backend result.
-   Retrying does not silently discard the user's mappings.
-   A successful import can be confirmed in the catalog/backend.
-   Duplicate/upsert behavior is clear and tested.

### Purchase desk

-   Valid requests reach the backend.
-   Invalid client-side values are rejected before submission.
-   API errors are not presented as policy rejections.
-   No eligible offer is an explicit state.
-   Policy failure is explicit.
-   Recommendation and authorization remain separate.
-   Payment remains locked/not enabled unless a genuine payment workflow
    is implemented.

### Navigation and responsive layout

-   All visible navigation links work.
-   Back/forward navigation works.
-   No page-level horizontal overflow at 320 px.
-   Import table remains inspectable on mobile.
-   Drawer opens and closes by button, Escape where applicable, and
    navigation.
-   Keyboard focus is visible and not trapped unexpectedly.

### Visual quality

-   No body/table text below 13 px for ordinary content except truly
    secondary metadata.
-   No repeated identical cards used purely to fill space.
-   No generic green-centered palette.
-   No neon, glow, or gratuitous AI decoration.
-   No fake charts, customer logos, metrics, or success states.
-   Clear hierarchy between title, body, labels, metadata, and status.
-   Primary action is obvious without overpowering every screen.

------------------------------------------------------------------------

## 12. Delivery strategy and Git workflow

Keep commits small enough to review, but group related work so that the
repository history remains understandable.

Suggested commit sequence: 1.
`docs: add frontend redesign execution plan` 2.
`style: establish Mandate design tokens and theme support` 3.
`ui: refine application shell and shared components` 4.
`ui: redesign vendor import workflow` 5.
`ui: improve purchase decision and comparison screens` 6.
`ui: refine dashboard and remaining workspace pages` 7.
`ui: polish landing, onboarding, and authentication` 8.
`test: verify responsive and theme behavior`

Before each change: - Fetch the latest branch state. - Avoid overwriting
unrelated changes. - Make the smallest coherent patch. - Build/test
after significant phases. - Report what changed and what was actually
verified.

Do not claim tests passed unless they were run. If browser testing is
unavailable, state that explicitly and distinguish source-level checks
from actual runtime verification.

------------------------------------------------------------------------

## 13. Design review checklist

Before calling the redesign finished, review each screen and ask:

### Identity

-   Does this look like Mandate rather than a template?
-   Is the palette memorable without becoming loud?
-   Is there a clear type and spacing system?
-   Are there any leftover generic green accents or arbitrary colors?

### Clarity

-   Can a user identify the page purpose in three seconds?
-   Is the primary action clear?
-   Is body text readable at normal zoom?
-   Are totals, dates, IDs, and scores easy to scan?

### Trust

-   Is every metric sourced from real data?
-   Is every success state backed by a successful operation?
-   Is preview distinguished from persistence?
-   Are recommendation, validation, approval, and payment distinct?

### Interaction

-   Does every control do what it says?
-   Are errors specific and recoverable?
-   Are loading and disabled states clear?
-   Does the mobile layout preserve the task rather than merely shrink
    the desktop page?

### Accessibility

-   Does keyboard navigation work?
-   Is focus visible?
-   Do both themes pass contrast checks?
-   Does reduced-motion mode work?

------------------------------------------------------------------------

## 14. Final definition of done

The redesign is complete only when:

-   The visual identity is consistent and distinctive across public and
    authenticated screens.
-   The palette uses the proposed ink/plum, warm chalk, persimmon, and
    cobalt direction---or a tested, deliberate refinement of it---not
    generic green branding.
-   Light, dark, and system themes work across all pages.
-   Typography and form/table sizing are comfortably readable.
-   Vendor import is a clear, multi-stage, truthful workflow with real
    backend results.
-   Purchase evaluation clearly separates recommendation, deterministic
    policy validation, human decision, and payment execution.
-   Dashboard and operational pages contain no fabricated live data.
-   Unimplemented features are honestly labeled.
-   Mobile and keyboard workflows are usable.
-   Frontend build and relevant tests have been run, with results
    reported accurately.
-   No regression has been knowingly introduced into working backend
    integrations.

**Design north star:** Mandate should feel considered, trustworthy, and
a little unexpected---a sharp decision-making tool for consequential
purchases, not another green AI dashboard.
