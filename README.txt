================================================================================
                     EAGLE WEB IDE (Python + JavaScript + HTML + CSS)
================================================================================

A browser-based IDE with real-time code execution for Python, JavaScript, and
browser-based HTML/CSS projects, AI-powered features, assignment management,
interactive challenges, and a full user management suite for educational
environments. Designed for public-facing classroom deployment.

See docs/HARDENING_AND_PERFORMANCE.md for security controls, capacity tuning,
isolated HTML preview deployment, monitoring, and load-test guidance.

================================================================================
                              TABLE OF CONTENTS
================================================================================

1. System Requirements
2. Installation
3. Configuration
4. Running the Application
5. Using the IDE
5A. Public Coding Wiki
6. AI Features
7. Assignment System
8. Admin Panel
9. User Management
10. Security Architecture
11. File Structure
12. Important Notes
13. Troubleshooting
14. Network Deployment

================================================================================
                           1. SYSTEM REQUIREMENTS
================================================================================

Required:
- Python 3.9 or higher  (uses PEP 585 built-in generics; 3.8 is NOT supported)
- Node.js 18 or higher (for JavaScript execution)
- Modern web browser (Chrome, Firefox, Edge, Safari)
- Internet connection (for CDN resources; required at page load for CodeMirror,
  Socket.IO, marked, DOMPurify, highlight.js, and Google Fonts)

Optional (for AI features):
- Ollama installed and running (https://ollama.ai)
- Compatible AI model (default: gemma3:4b)

See REQUIREMENTS.md for a full dependency audit including Python packages,
browser-side CDN libraries, and optional Ollama setup.

--------------------------------------------------
INSTALLING NODE.JS
--------------------------------------------------
Node.js is required for JavaScript (.js) file execution.

  Ubuntu/Debian:
    sudo apt install nodejs

  Fedora/RHEL:
    sudo dnf install nodejs

  macOS (with Homebrew):
    brew install node

  Windows:
    Download installer from https://nodejs.org/

Verify installation:
  node --version    # should print v18 or higher

================================================================================
                              2. INSTALLATION
================================================================================

Step 1: Clone or download the repository
  git clone https://github.com/bkgodwin/EagleIDE.git
  cd EagleIDE

Step 2: Install Python dependencies
  pip install -r requirements.txt

Step 3: Verify installation
  python app.py

The server should start on http://0.0.0.0:8000

================================================================================
                             3. CONFIGURATION
================================================================================

Configuration is managed through config.py. Key settings include:

--------------------------------------------------
ADMIN CREDENTIALS (ENCRYPTED ON FIRST START)
--------------------------------------------------
On first startup, the server prompts for admin email/password in the terminal.
Both are persisted to config.txt, and the password is encrypted at rest using
Fernet symmetric encryption. Admin email is stored in plaintext for login lookup;
password is Fernet-encrypted. If either value is blank or unreadable, the server
prompts again on next start.

--------------------------------------------------
AI/OLLAMA CONFIGURATION
--------------------------------------------------
"ai_explainer_enabled": True          # Master toggle for all AI features
"ai_ollama_url": "http://192.168.0.105:11434"  # Ollama server URL
"ai_model": "gemma3:4b"              # AI model name

Ollama URL Examples:
- Local installation: "http://127.0.0.1:11434" or "http://localhost:11434"
- Network server: "http://192.168.0.105:11434"
- Remote server: "http://your-server-ip:11434"

To disable AI features: Set "ai_explainer_enabled": False

--------------------------------------------------
LESSON CONFIGURATION
--------------------------------------------------
"lesson_url": "https://..."          # External lesson URL
"lesson_use_local": False            # Use local HTML instead of URL
"lesson_html": "<p>...</p>"          # Local lesson content (if enabled)

--------------------------------------------------
PAGE CUSTOMIZATION
--------------------------------------------------
"page_title": "Eagle IDE (Python)"
"topbar_color": "linear-gradient(90deg,#a5c8f0,#7fb2eb)"
"notes_html": "<h2>Welcome</h2>..."   # Home panel content (admin instructions)

--------------------------------------------------
AI ASSISTANT BEHAVIOR
--------------------------------------------------
"ai_assistant_preprompt": "..."      # System prompt for AI tutor
Customize how the AI assistant responds to students.

--------------------------------------------------
ENVIRONMENT VARIABLES (Optional)
--------------------------------------------------
You can also use environment variables:
- ADMIN_PASSWORD: Override default admin password
- HOST: Server host (default: 0.0.0.0)
- PORT: Server port (default: 8000)

Example:
  export ADMIN_PASSWORD="MySecurePassword123"
  export PORT=5000
  python app.py

================================================================================
                        4. RUNNING THE APPLICATION
================================================================================

--------------------------------------------------
BASIC USAGE
--------------------------------------------------
Use the project virtual environment so the compatible Socket.IO and WebSocket
packages from requirements.txt take precedence over Linux distribution packages:

  .venv/bin/python app.py                  # Linux/macOS
  .\.venv\Scripts\python.exe app.py        # Windows PowerShell

The server will start at: http://0.0.0.0:8000

The embedded Werkzeug server is intended for local or classroom-network use.
EagleIDE includes a compatibility guard for a known harmless Werkzeug/Engine.IO
traceback that some package combinations log when a healthy WebSocket disconnects.

--------------------------------------------------
CUSTOM HOST/PORT
--------------------------------------------------
HOST=127.0.0.1 PORT=5000 python app.py

--------------------------------------------------
PRODUCTION DEPLOYMENT
--------------------------------------------------
For production use, consider:
1. Using a production WSGI server (gunicorn, waitress)
2. Setting up reverse proxy (nginx, Apache)
3. Enabling HTTPS via reverse proxy (Let's Encrypt / Certbot)
4. Setting a strong admin password on first startup
5. Restricting network access as needed

================================================================================
                            5. USING THE IDE
================================================================================

Students can:
1. Write Python, JavaScript, HTML, or CSS code in the editor
2. Run code with the "Run ▶" button
3. Stop execution with "Stop ⏹"
4. Create, save, and run .py, .js, and .html files
5. Import/export .py, .js, .html, .css, or .txt files
6. Adjust font size with the slider
7. View output in the terminal panel
8. Provide input when programs use input()
9. View lessons and Home content in the sidebar

Features:
- Syntax highlighting for Python, JavaScript, HTML, and CSS
- Intelligent autocomplete (keywords, builtins, defined symbols)
- Auto-indentation
- Line numbers
- Error highlighting
- Real-time code execution (30 second timeout)
- Interactive input support (input() works in both Python and JavaScript)
- Drag-and-drop file organization

Account and classroom defaults:
- New student and teacher workspaces include an Examples folder with Python, JavaScript, HTML, CSS, CSV, and text starter files.
- Opening the file browser repairs the Examples folder for an older account if the folder is missing; files users intentionally remove are not recreated on every refresh.
- Live editor streaming is available to teachers only and remains limited to classes they own.
- A class's AI enabled switch controls student access. The owning teacher retains AI explaining, chat, grading, and reporting tools while site-wide AI remains enabled.

--------------------------------------------------
SCREEN LAYOUT AND SCROLLING
--------------------------------------------------
- The workspace stays fitted to the visible browser area; the browser page itself does not scroll.
- The editor side and the shell/resources side scroll independently.
- Shell output remains inside its panel, scrolls automatically to the newest output, and can still be scrolled manually to review earlier output.
- On tablets and phones, use the bottom Editor, Shell, and Resources buttons to switch panels.
- Touch scrolling and drag handles use larger touch targets on touch-capable devices.
- When an on-screen keyboard changes the visible browser height, the workspace resizes to keep the active panel and shell controls on screen.

--------------------------------------------------
HTML/CSS WEBVIEW RUNTIME
--------------------------------------------------
- Create and edit .html and .css files in the file browser
- Click Run on an .html file to open a popup WebView window
- HTML output renders live with linked CSS/JS from the project folder
- Runtime auto-stops at the configured timeout (default 30 seconds)
- JavaScript runtime errors are mirrored to the shell panel
- Popup includes a header and Exit button, and auto-cleans on close

Admin HTML runtime config keys:
- "html_runtime_enabled": true/false
- "html_runtime_timeout_seconds": 30
- "html_runtime_allow_external_internet": true/false
- "html_runtime_allow_popups": true/false
- "html_runtime_allow_navigation": true/false
- "html_runtime_max_fps": 30
- "html_runtime_memory_limit_mb": 128
- "html_runtime_max_dom_nodes": 3000
- "html_runtime_max_popups": 2

--------------------------------------------------
JAVASCRIPT SUPPORT
--------------------------------------------------
- Create .js files in the file browser
- The editor switches to JavaScript syntax highlighting automatically
- A synchronous input() function is available in JavaScript files:
    let name = input("Enter your name: ");
    console.log("Hello, " + name + "!");
- Output (console.log, console.error, etc.) appears in the shell
- All shell input features work the same as with Python
- JavaScript files are identified by the ⚡ icon in the file browser

================================================================================
                         5A. PUBLIC CODING WIKI
================================================================================

The public wiki is the application's landing page. Guests can browse, search,
follow topic links, view uploaded media, and open runnable examples in the IDE
without signing in. Guests cannot bookmark content. The IDE's Wiki tab uses an
embedded reader for the same content.

Reader features:
- A show/hide contents sidebar on both the home and article views, with an
  admin-ordered folder tree and keyboard, mouse, and touch controls
- Folder rows expand or collapse their children; only pages and media open a reader
- Two home reference columns: a structured Standards table and an External
  Resources table with a title, HTTP/HTTPS link, and description
- Full-text search across page titles, aliases, headings, and Markdown content;
  opening a result jumps to and highlights the matching text
- Automatic links for unambiguous page titles, aliases, and section headings
- Mouse hover previews show clean context at each matching location with arrow
  controls when a term occurs more than once; on touch devices, first tap previews
  and second tap opens
- Sanitized Markdown, stable section links, and a generated table of contents
- Expandable standards-covered tags beneath each page's table of contents
- A standards coverage report with root class-folder icons, folder filtering, and
  a print/PDF layout that preserves the active filter in the report title
- Copy and Open in IDE buttons on Python, JavaScript, HTML, and CSS code fences
- Inline images, pre-encoded MP4 video, and PDF viewing; other allowed files can
  be organized in the same tree and downloaded. Wiki images reserve their
  dimensions and begin loading shortly before they enter the viewport to reduce
  bandwidth without causing content to jump.

Student and teacher workflow:
- Signed-in students can add or remove personal bookmarks. They appear in the
  Bookmarks menu.
- A teacher's Lesson Material bookmark is assigned to one teacher-owned class.
  Students in that class see it with the Lesson Material label. The class picker
  is shown whenever the teacher bookmarks or features an item.
- Teachers can feature a page or folder for one class. A featured folder always
  includes its current descendants, including children added later.
- Guests see the complete published tree in the order chosen by the admin, with
  no class-specific featured section.

Admin Wiki Manager:
1. Sign in as admin and choose Wiki Manager in the top bar.
2. Use the Home tab to change the landing-page title, supporting text, site footer,
   structured Standards, and External Resources table. Standards require an ID and
   description and can be assigned to individual pages from Item settings. The
   page editor's standards browser searches full IDs and descriptions, can show
   selected standards only, and keeps the complete description readable. To add
   standards in bulk, choose Import CSV and upload a UTF-8 file with Standard ID and
   Description headers. Existing matching IDs are updated and new IDs are appended.
3. Use the Content tab to create folders and pages, or upload an existing .md
   page. Folder and page icons accept standard Unicode emoji; the picker includes
   coding, JavaScript, server, and system-administration choices. Drag the tree handle to move
   items before, after, or inside folders; Move Up/Down remains available. New pages are drafts;
   expand their folders in Wiki Manager and select Published when they are ready
   to appear in the public contents sidebar.
4. Edit Markdown with an independently autosaved draft. Page settings collapse to
   keep the editor in view, and Editor, Split, and Preview modes make better use of
   the available screen. Published content remains unchanged until explicit save.
5. Place the Markdown cursor where an image belongs and choose Insert Image. The
   device file picker opens first; after selecting a file, set its alt text,
   caption, alignment, and width. A visible image directive is inserted at the
   saved cursor position and controls its vertical placement and preview. Removing
   the directive removes the image from the page. Image assets do not appear in
   the public or admin content tree.
6. Use the Media tab to upload and review images. Permanent deletion also removes
   the stored file and its directives from published pages and autosaved drafts.
   Upload videos and other attachments from Content, then move and reorder them in
   the folder tree.
7. Review the latest three published page revisions and the compact admin-only analytics tab. Search analytics
   count completed searches only: selecting a result or submitting with Enter or
   the Search button.

Allowed uploads are PNG, JPEG, WebP, GIF, MP4, PDF, TXT, CSV, PY, JS, HTML, CSS,
JSON, and ZIP. The server verifies both the extension and basic file signature.
HTML, JavaScript, and ZIP attachments are always downloaded rather than rendered.
For predictable playback and good iPad compatibility, encode video as an MP4 with
H.264 video, AAC audio, and web-optimized/fast-start metadata before uploading.

Wiki backup and restore:
- Download Backup creates a portable ZIP containing the catalog structure,
  settings, Markdown, media, drafts, revisions, class features, and analytics.
- Personal and Lesson Material bookmarks are intentionally excluded.
- Restore validates paths and checksums, creates an automatic pre-restore backup,
  replaces wiki content/settings, and preserves the bookmarks currently on the
  server.
- Runtime data is stored in wiki_data/ and temporary/downloadable archives in
  wiki_backups/. Both are ignored by Git. For isolated deployments or testing,
  set EAGLEIDE_WIKI_DATA_DIR and EAGLEIDE_WIKI_BACKUP_DIR to absolute paths.

Default limits are 1 GB per asset and 10 GB total wiki media. Operators can change
wiki_max_asset_mb and wiki_total_asset_mb in the application configuration.

================================================================================
                            6. AI FEATURES
================================================================================

Requires Ollama to be running with a compatible model.

--------------------------------------------------
CODE EXPLAINER
--------------------------------------------------
- Click "Explain Code" button
- AI analyzes your code and provides feedback
- Identifies errors and suggests fixes
- 30-90 second cooldown between requests

--------------------------------------------------
CODING CHALLENGES
--------------------------------------------------
- Select difficulty level (1-5)
- Get random challenge from challenges.csv
- Submit solution for AI grading while signed in
- Each account keeps one latest score per challenge
- Leaderboard totals all challenge scores for every account

--------------------------------------------------
AI ASSISTANT (TUTOR)
--------------------------------------------------
- Chat-based help for Python questions
- Provides hints, not complete solutions
- 15 second cooldown per message
- Guided learning approach

================================================================================
                          7. ASSIGNMENT SYSTEM
================================================================================

--------------------------------------------------
FOR STUDENTS
--------------------------------------------------
1. View assignments in the Assignments tab only after joining a class
2. Join a class from the Assignments tab using the 6-character class code
   (once joined, students cannot self-leave)
3. Click assignment to view details
4. Sign in with your student account
5. Choose one of your saved files to submit
6. The selected file is copied to the assignment owner's assignment folder and
   renamed to the student's name, with a submission comment at the top that
   includes student name and timestamp
7. Resubmissions replace your previous file for that assignment

--------------------------------------------------
FOR TEACHERS
--------------------------------------------------
1. Login with a teacher account (created by admin)
2. Teachers create classes and receive random 6-character join codes
3. Teachers manage class membership (remove students, lock/unlock, reset
   passwords) and can delete classes
4. Deleting a class unassigns all enrolled students so they can join a new class
5. Create new assignments with:
   - Assignment name
   - Task description
   - Maximum score
   - Target class
6. Lock/unlock assignments
7. Edit or delete assignments from the assignment manager
8. Open submitted files directly from the assignment owner workspace
9. Grade from the left sidebar with auto-saving score changes or AI grading
10. Review alphabetized score tables and download scores as CSV

================================================================================
                            8. ADMIN PANEL
================================================================================

Access: Click the "⚙" button in the top bar and sign in with admin credentials.

--------------------------------------------------
ADMIN SETTINGS (⚙ button)
--------------------------------------------------
- Edit page title and top bar color
- Configure AI settings (Ollama URL, model, assistant preprompt)
- Enable/disable AI features globally
- Configure HTML runtime settings
- Enable/disable student self-registration
- Create teacher accounts
- View student list with registration and last-sign-in timestamps

--------------------------------------------------
USER MANAGEMENT (👥 Users button, admin only)
--------------------------------------------------
See Section 9 (User Management) for full details.

--------------------------------------------------
IMPORTANT
--------------------------------------------------
Admin sessions are temporary (token stored in memory) and cleared on server
restart. Always keep your admin password secure. Admin credentials (email +
encrypted password) are stored in config.txt.

================================================================================
                           9. USER MANAGEMENT
================================================================================

Access: Click the "👥 Users" button in the top bar (visible only when signed
in as admin).

--------------------------------------------------
OVERVIEW
--------------------------------------------------
The User Management panel provides the admin with full control over all student
and teacher accounts. Admin cannot view the contents of user files from this
panel — all file operations are performed blindly to protect user privacy.

--------------------------------------------------
PER-USER STATISTICS
--------------------------------------------------
Each user row displays:
- Name and email address
- Role (student / teacher)
- Enrolled class (if applicable)
- Account creation date
- Last sign-in timestamp
- Last known IP address (recorded at each login)
- Storage used (total bytes / KB / MB)
- Total file count
- Account status (Active / Disabled)

--------------------------------------------------
BULK OPERATIONS
--------------------------------------------------
Select multiple users with checkboxes (or use "Select All") to perform:

  Enable Selected    - Re-activate disabled accounts
  Disable Selected   - Prevent selected accounts from signing in without
                       deleting any data; active sessions are revoked
  Clear Files        - Permanently delete ALL stored files for selected
                       accounts; the accounts themselves remain active
  Delete Selected    - Permanently delete the account record AND all files
                       for each selected user; this cannot be undone

--------------------------------------------------
SINGLE-USER ACTIONS
--------------------------------------------------
Each row has individual action buttons:
- Reset PW   - Generate a temporary random password (shown only to admin)
- Disable / Enable - Toggle account lock status
- Files      - Clear all stored files for that account
- Delete     - Permanently delete the account and all its files

--------------------------------------------------
DELETION BEHAVIOR
--------------------------------------------------
When a user is deleted:
- Their account record is removed from users.json
- All active login tokens are invalidated
- They are removed from any enrolled class
- If a teacher, all their classes are deleted
- All files in their user directory are permanently deleted
- New accounts registered with the same email start completely fresh

--------------------------------------------------
PRIVACY NOTE
--------------------------------------------------
Admins cannot browse or read the content of user files from any admin panel.
The clear-files action deletes files without exposing their content. This design
ensures user data remains private while giving admins the administrative control
they need.

================================================================================
                         10. SECURITY ARCHITECTURE
================================================================================

--------------------------------------------------
AUTHENTICATION
--------------------------------------------------
- Student/teacher passwords hashed with bcrypt (cost factor >= 12)
- Admin password encrypted at rest with Fernet symmetric encryption
- Admin credentials compared using HMAC constant-time comparison to prevent
  timing-based enumeration
- All session tokens are 128-bit random hex strings (uuid4)
- Tokens are ephemeral — server restart invalidates all sessions

--------------------------------------------------
RATE LIMITING
--------------------------------------------------
- Student/teacher login: max 20 attempts per 15 minutes per IP
- Admin login: max 10 attempts per 15 minutes per IP
- Registration: max 5 accounts per hour per IP

--------------------------------------------------
CODE EXECUTION SANDBOX
--------------------------------------------------
Python:
- Code runs in a dedicated sandbox worker process (sandbox_worker.py), separate
  from the web server interpreter
- User code executes in a dedicated namespace with explicit safe builtins only
- Blocked modules include: subprocess, multiprocessing, socket, socketserver,
  ftplib, http, urllib, xmlrpc, smtplib, imaplib, poplib, nntplib, telnetlib,
  ssl, ctypes, cffi, mmap, inspect, resource, fcntl, pty, asyncio.subprocess
- File I/O is boundary-checked against the user's workspace root (realpath +
  normalized path checks to block traversal and symlink escapes)
- os process-spawn APIs (fork/exec/spawn/system/popen) are blocked; sensitive
  os filesystem helpers are path-guarded to the same workspace boundary
- Resource limits: 256 MB virtual memory, 64 open file descriptors (Linux)
- Wall-clock timeout enforced per execution
- Output capped at a maximum byte limit to prevent flooding

JavaScript:
- Code runs in a Node.js subprocess
- Network operations are available in Node (consider network isolation)
- Standard execution timeout applies

--------------------------------------------------
API SECURITY
--------------------------------------------------
- Every API route requires appropriate token in request headers
  (X-Admin-Token, X-Teacher-Token, or X-User-Token)
- Path traversal prevented on all file operations via _validate_user_path()
- User files are strictly isolated -- users can only access their own files
- All HTML rendered from user data uses DOMPurify sanitization
- Text rendered in the DOM uses textContent / escapeHtml() (no innerHTML
  with raw user data)

--------------------------------------------------
HTTP SECURITY HEADERS
--------------------------------------------------
All HTTP responses include:
- X-Content-Type-Options: nosniff
- X-Frame-Options: SAMEORIGIN
- Referrer-Policy: strict-origin-when-cross-origin
- Permissions-Policy: geolocation=(), camera=(), microphone=()

--------------------------------------------------
STORAGE LIMITS
--------------------------------------------------
- Per-user storage cap (configurable in config.py, default 10 MB)
- Per-account file count limit (default 100 files)
- Per-folder file count limit (default 20 files)

--------------------------------------------------
SECURITY RECOMMENDATIONS FOR PRODUCTION
--------------------------------------------------
1. Run behind a TLS-terminating reverse proxy (nginx + Let's Encrypt)
2. Set a strong, unique admin password at first startup
3. Restrict the HOST to 127.0.0.1 and proxy through nginx/Apache
4. Isolate the server process (Docker, systemd sandboxing, or similar)
5. Keep Python and Node.js updated
6. Regularly review access logs for suspicious patterns
7. For JavaScript execution: network-isolate the server if students
   could abuse Node.js network APIs

================================================================================
                          11. FILE STRUCTURE
================================================================================

Core Files:
  app.py              - Main Flask application server
  sandbox_worker.py   - Isolated Python execution worker runtime
  config.py           - Configuration settings and defaults
  index.html          - Single-page web interface
  challenges.csv      - Coding challenge bank
  requirements.txt    - Python dependencies
  README.txt          - This file

Auto-Generated Directories:
  sandboxes/          - Temporary code execution folders
  assignments/        - Assignment JSON files
  user_files/         - Per-user file storage (one subdirectory per account)

Auto-Generated Files:
  config.txt          - Runtime configuration (persisted)
  users.json          - User account records (passwords bcrypt-hashed)
  classes.json        - Class records and enrollment data
  challenge_scores.json - Per-account challenge score tracker
  .admin_key          - Fernet key for admin password encryption (keep secure)

================================================================================
                          12. IMPORTANT NOTES
================================================================================

WARNING: SECURITY
--------------------------------------------------
- Set a strong admin password at first startup
- Python code runs in a sandboxed subprocess with import and filesystem
  restrictions; JavaScript runs via Node.js (less sandboxed)
- Execution timeouts prevent infinite loops
- For public internet exposure: always use HTTPS via a reverse proxy
- The .admin_key file must be kept secure; losing it requires re-running
  first-time setup

WARNING: OLLAMA CONFIGURATION
--------------------------------------------------
If Ollama is on the SAME machine:
  "ai_ollama_url": "http://127.0.0.1:11434"

If Ollama is on a DIFFERENT machine:
  "ai_ollama_url": "http://<ollama-server-ip>:11434"
  Example: "http://192.168.0.105:11434"

Make sure Ollama is running and the model is downloaded:
  ollama serve
  ollama pull gemma3:4b

WARNING: CHALLENGES.CSV FORMAT
--------------------------------------------------
File must have columns: difficulty,points,text
Example:
  difficulty,points,text
  1,5,Write a function that adds two numbers
  2,10,Create a loop that prints even numbers from 1 to 20

================================================================================
                          13. TROUBLESHOOTING
================================================================================

Problem: JavaScript files won't run
Solution:
- Verify Node.js is installed: node --version
- Ensure version is 18 or higher
- Check that the file has a .js extension
- Check browser console for errors

Problem: input() not working in JavaScript
Solution:
- The input() function is provided automatically for .js files
- Wait for [[_IDE_INPUT_]] token to appear in the shell
- Type your input and press Send or Enter
- Do NOT use readline or process.stdin directly; use input() instead

Problem: Browser trying to autofill the shell input with saved passwords
Solution:
- This is prevented by autocomplete="off" on the shell input field
- If autofill still appears, dismiss it; it will not affect code execution

Problem: Server won't start
Solution: Check if port 8000 is already in use, try different port

Problem: AI features not working
Solution:
- Verify Ollama is running: ollama serve
- Check Ollama URL in config.py
- Verify model is installed: ollama list
- Check ai_explainer_enabled is True

Problem: Code won't execute
Solution:
- Check browser console for errors
- Verify Python is installed
- Check file permissions on sandboxes/ directory

Problem: Can't login to admin
Solution:
- Verify admin credentials set during first-time setup
- Server restart clears admin tokens (re-login required)
- If credentials were lost, delete config.txt and .admin_key — server
  will prompt for new credentials on next start (WARNING: this resets
  the encrypted admin password)

Problem: Getting "Too many login attempts" error
Solution:
- Wait 15 minutes for the rate limit window to expire
- This limit applies per IP: up to 20 student/teacher attempts or 10
  admin attempts per 15-minute window

Problem: Input() not working
Solution:
- Wait for [[_IDE_INPUT_]] token to appear
- Type input and press Send or Enter
- Check terminal panel is visible

================================================================================
                        14. NETWORK DEPLOYMENT
================================================================================

For classroom or multi-user deployment:

1. Find server IP address:
   - Windows: ipconfig
   - Mac/Linux: ifconfig or ip addr

2. Start server on all interfaces:
   HOST=0.0.0.0 PORT=8000 python app.py

3. Students access via:
   http://<server-ip>:8000
   Example: http://192.168.1.100:8000

4. Configure firewall to allow port 8000

5. If using Ollama on a different machine:
   - Update ai_ollama_url in config.py
   - Ensure Ollama server is accessible on network

6. For HTTPS (strongly recommended for internet-facing deployments):
   - Run a reverse proxy (nginx, Apache, Caddy)
   - Obtain a TLS certificate (Let's Encrypt / Certbot)
   - Proxy HTTPS traffic to localhost:8000

================================================================================

================================================================================
                  15. OPTIONAL NETWORK SIMULATOR
================================================================================

EagleIDE includes a modular browser-based Network Simulator for LANs,
routing, VLANs, IPv4/IPv6, wireless, RSTP, stateful firewalls/PAT, safe
cybersecurity scenarios, Wireshark-style packet capture, and automatically
graded labs. Seeded background traffic runs in a Web Worker so realistic ARP,
DHCP, DNS, HTTP/TLS, and attack-indicator traffic does not block the editor UI.

DHCP clients support Automatic and Manual addressing. Router LAN ports have
independent gateway addresses, masks, and VLANs; a DHCP scope binds to one LAN
interface and derives its gateway/mask/VLAN to prevent contradictory settings.
Packet Test can broadcast DHCP Discover and display the full
Discover, Offer, Request, and Acknowledgment exchange.

Physical ports are finite: PCs and laptops have one LAN port, servers have four,
Layer 2 and Layer 3 switches have eight Ethernet ports, and routers separate WAN from LAN. Cable
creation prompts for an available port at each endpoint. Ports expose link state
and speed controls. Ethernet, fiber, and serial links render differently, and
line thickness reflects the slower endpoint's negotiated speed. Authenticated
wireless clients display a dotted association to their nearest matching WAP.
Server LAN ports have independent IPv4 configuration.
Routers support static or ISP-DHCP WAN addressing and NAT.

Layer 2 switches provide access/trunk VLAN behavior without routing. Layer 3
switches add SVIs, inter-VLAN routing, static routes, and ordered ACLs. Routers
also support ordered protocol/source/destination/port ACLs. Layer 3 switch ACLs
can be attached to an SVI such as VLAN20, matching common inter-VLAN practice.
Blocked packet animation stops at the enforcing device and clearly identifies
ACL, VLAN, firewall, link-state, routing, gateway, or service failures.

DNS servers include structured A, CNAME, and NS records, recursive resolution,
fallback forwarders, TTL caching, and multi-level delegation. The DNS + HTTP
packet workflow resolves a domain and then simulates TCP/80 and an HTTP GET.
Packet traces can be stepped or played in a continuous loop with an animated marker
moving one physical link at a time; the Play button becomes Stop while looping.
Device settings use touch-friendly menus for finite choices and topology-aware
suggestions for masks, VLANs, SSIDs, networks, domains, and ports. IPv4, gateway,
DNS, and pool-address fields remain direct entry to avoid long menus. The
Configuration and Network Tools panes are resizable. The bottom Reference tab
lists supported CLI commands, common service ports, and common acronyms.

Administrator:
- Open Settings -> Network Sim to enable or disable the app globally.
- Admins can privately preview it while disabled.

Teacher:
- Open Dashboard -> Network Sim.
- Select a class, allow class access, and assign one of the built-in labs.
- Use Open to Demonstrate for a temporary teacher copy with the Lab Guide and
  solution visible beside the simulator.
- Expand a lab to see student instructions, the step-by-step solution, and each
  student's completion state, objective progress, score, and last save time.

Student/guest:
- Use Network Sim in the top bar when access is enabled.
- Start blank, open an example, or resume an assigned lab.
- Follow the practice objectives included with every example topology.
- Reset any selected device to defaults without removing its cables.
- Guests can simulate and export but cannot save.

See docs/NETWORK_SIMULATOR.md for the full illustrated workflow, device
capabilities, lab descriptions, command reference, and operations notes.

================================================================================

For support or issues: https://github.com/bkgodwin/EagleIDE

Last Updated: 2026-07-14
