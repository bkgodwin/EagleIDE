# Eagle Lab workspace and reports

The Lab button appears for students with current membership in an enabled lab
class while the global lab switch is enabled. Its lightweight access request
does not contact Proxmox. Teachers retain their existing class-owner controls;
administrators retain enrollment and private preview authority.

## Student workspace

Choose a class, search the assigned server cards, and open a server's details to
connect. Refresh updates the catalog without reloading an open PVE console.
Reports open directly from the Lab page as well as the console toolbar.

Reports float above the workspace without blocking it. Drag the grip, use its
arrow-key controls, drag the bottom corner to resize, or minimize the panel.
Viewport/keyboard changes keep controls on screen. Close saves pending work;
a failed save keeps the report open. Every procedure checkbox must be selected
for credit. Server-side draft/final response validation and scoring still apply.

Highlighted report text copies to the clipboard on click or keyboard activation.
If browser clipboard permission is unavailable, the text remains selectable.
The report retains the same revision conflict and account isolation controls.

## Teacher workflow

Class access changes remain in memory per class and session until saved. Refresh
and class switches preserve them; signing out clears them. If you continue
editing while a save is in progress, the response retains those newer edits and
shows that they still need saving.

Select **Lab report** in the assignment composer. Its student preview updates as
you write. Add written-response, fill-in-the-blank, or procedure sections. Existing
sections can be edited, deleted, and moved up. Accepted answers stay private.

Wrap a command or other copyable text in curly brackets, for example
`{ip -br addr}`. Students see a highlighted copy button containing `ip -br addr`.
HTML is displayed as text and never executed. Use **Add image** in a section to
attach a screenshot, give it a meaningful description, and inspect the preview.
The section editor supports removing illustrations. The task description also
supports image insertion. Only uploaded local images load; external image URLs
are never fetched.

Images accept static JPEG/PNG uploads of at most 5 MB and 25 million pixels.
The server removes metadata, reencodes JPEG, and scales the longest edge to at
most 1920 pixels. Each author has 100 images / 50 MB, including images from
abandoned drafts. Images are retained when removed from a report, so other
reports referencing them keep working. This release does not add automatic
media deletion. Back up `.lab-report-media` together with assignments.

Image access requires authenticated author access or a referenced report in the
image's original class with current student/staff access. Copying an image token
into a different class does not grant access. Upload it in the destination class
when preparing a separate class report. No auth token enters an image URL.

## Lab Manual

The manual opens from the Lab page or console toolbar and can stay beside a
report. Search or select chapters for Linux commands, Proxmox host commands,
Proxmox vocabulary, IP addressing and ports, LXC/VM creation and backups, and
hosting Python apps or static websites. Commands copy without executing.
Examples identify whether they run inside the guest or on the PVE host and use
placeholders for classroom-specific IDs and addresses.

Official references include the [Proxmox documentation hub](https://pve.proxmox.com/pve-docs/),
[administration guide](https://pve.proxmox.com/pve-docs/pve-admin-guide.html),
[container command reference](https://pve.proxmox.com/pve-docs/pct.1.html),
[VM command reference](https://pve.proxmox.com/pve-docs/qm.1.html),
[Python virtual environments](https://docs.python.org/3/library/venv.html), and
[Flask deployment guidance](https://flask.palletsprojects.com/en/stable/deploying/).

## Performance and verification

Catalog status probes share one eight-worker pool across the classroom, with a
maximum of 100 queued/in-flight probes. Identical server revisions share a
probe and a 15-second cache. A request waits at most 4.5 seconds for probes;
unfinished nodes show checking or their previous status. Status is requested
on demand rather than continuously polling. Console HTTP/WebSocket streaming,
backpressure, PVE sandboxing, PINs, TLS and fresh authorization are unchanged.

Illustrations load near the viewport with two parallel reads per window. Preview
blobs are session scoped, limited to 12 images / 12 MB, and discarded on account
change; object URLs and observers are released when windows close. Draft writes
remain debounced and serialized; unchanged reports do not cause another write.

Automated regression checks:

```text
python -m unittest tests.test_eagle_lab tests.test_lab_report_media -v
node --test tests/eagle_lab_ui.test.js tests/lab_report_content.test.js
```

For full browser verification start `python tests/lesson_plan_browser_fixture.py
--lab`. Set `EAGLE_LAB_TEST_URL` to the printed loopback URL, optionally set
`EAGLE_LAB_BROWSER` to an installed Chromium executable and
`EAGLE_LAB_PLAYWRIGHT_MODULE` to Playwright's module entry point, then run
`node tests/eagle_lab_polish_browser_checks.mjs`. `EAGLE_LAB_SCREENSHOT_DIR`
selects a private scratch screenshot directory. All accounts, files and report
images in this fixture are temporary. The synthetic gateway checks in
`eagle_lab_browser_checks.mjs` separately cover console isolation and revocation.
Test a real classroom PVE deployment separately for its console latency and
available bandwidth; the synthetic fixtures do not measure production throughput.
