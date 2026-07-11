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
python app.py

The server will start at: http://0.0.0.0:8000

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

For support or issues: https://github.com/bkgodwin/EagleIDE

Last Updated: 2026-05-15
