import re
import unittest
from collections import Counter
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urlsplit


BASE_DIR = Path(__file__).resolve().parents[1]


class _DocumentInventory(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=False)
        self.ids = []
        self.local_assets = []
        self.tag_counts = Counter()

    def handle_starttag(self, tag, attrs):
        self.tag_counts[tag] += 1
        values = dict(attrs)
        if values.get("id"):
            self.ids.append(values["id"])
        asset = values.get("src") if tag == "script" else values.get("href") if tag == "link" else ""
        path = urlsplit(asset or "").path
        if path.startswith("/static/"):
            self.local_assets.append(path)


class StaticHtmlTestCase(unittest.TestCase):
    def setUp(self):
        self.raw = (BASE_DIR / "index.html").read_text(encoding="utf-8")
        self.parser = _DocumentInventory()
        self.parser.feed(self.raw)

    def test_document_has_single_root_sections_and_unique_ids(self):
        self.assertEqual(self.parser.tag_counts["html"], 1)
        self.assertEqual(self.parser.tag_counts["head"], 1)
        self.assertEqual(self.parser.tag_counts["body"], 1)
        duplicates = {key: count for key, count in Counter(self.parser.ids).items() if count > 1}
        self.assertEqual(duplicates, {})

    def test_all_local_script_and_style_assets_exist(self):
        missing = [path for path in self.parser.local_assets if not (BASE_DIR / path.lstrip("/")).exists()]
        self.assertEqual(missing, [])
        self.assertIn("marked@18.0.7/lib/marked.umd.js", self.raw)
        self.assertIn("dompurify@3.4.7/dist/purify.min.js", self.raw)
        self.assertEqual(self.raw.count('integrity="sha384-'), 2)

    def test_static_assets_use_classroom_friendly_cache_policy(self):
        source = (BASE_DIR / "app.py").read_text(encoding="utf-8")
        self.assertIn('"public, max-age=31536000, immutable"', source)
        self.assertIn('"public, max-age=300, must-revalidate"', source)

    def test_wiki_asset_cache_versions_stay_in_sync(self):
        main_css = (BASE_DIR / "static" / "css" / "main.css").read_text(encoding="utf-8")
        page_version = re.search(r'/static/css/main\.css\?v=([^"]+)', self.raw)
        import_version = re.search(r'features/wiki\.css\?v=([^"]+)', main_css)
        reader_version = re.search(r'/static/js/wiki-reader\.js\?v=([^"]+)', self.raw)
        admin_version = re.search(r'/static/js/wiki-admin\.js\?v=([^"]+)', self.raw)
        self.assertIsNotNone(page_version)
        self.assertIsNotNone(import_version)
        self.assertIsNotNone(reader_version)
        self.assertIsNotNone(admin_version)
        self.assertEqual(page_version.group(1), import_version.group(1))
        self.assertEqual(page_version.group(1), reader_version.group(1))
        self.assertEqual(page_version.group(1), admin_version.group(1))

    def test_ide_artifact_asset_cache_versions_stay_in_sync(self):
        main_css = (BASE_DIR / "static" / "css" / "main.css").read_text(encoding="utf-8")
        page_version = re.search(r'/static/css/main\.css\?v=([^"]+)', self.raw)
        editor_version = re.search(r'features/editor\.css\?v=([^"]+)', main_css)
        admin_version = re.search(r'features/admin\.css\?v=([^"]+)', main_css)
        app_core_version = re.search(r'/static/js/app-core\.js\?v=([^"]+)', self.raw)
        self.assertIsNotNone(page_version)
        self.assertIsNotNone(editor_version)
        self.assertIsNotNone(admin_version)
        self.assertIsNotNone(app_core_version)
        self.assertEqual(page_version.group(1), editor_version.group(1))
        self.assertEqual(page_version.group(1), admin_version.group(1))
        self.assertEqual(page_version.group(1), app_core_version.group(1))

    def test_teacher_skill_dashboard_has_bulk_selection_controls(self):
        ids = set(self.parser.ids)
        self.assertTrue({
            "teacherSkillSelectAll",
            "teacherSkillSelectionSummary",
            "bulkSkillClassChecklist",
            "bulkAssignSkillsBtn",
            "bulkDeleteSkillsBtn",
            "teacherSkillBulkStatus",
        }.issubset(ids))
        app_core = (BASE_DIR / "static" / "js" / "app-core.js").read_text(encoding="utf-8")
        self.assertIn("selectedTeacherSkillIds", app_core)
        self.assertIn("/api/teacher/skills/bulk-assign", app_core)
        self.assertIn("/api/teacher/skills/bulk-delete", app_core)

    def test_attribute_ampersands_are_html_escaped(self):
        unescaped = re.findall(r'(?:href|src)="[^"]*&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9A-Fa-f]+);)', self.raw)
        self.assertEqual(unescaped, [])

    def test_wiki_uses_shared_contents_sidebar_and_image_picker(self):
        ids = set(self.parser.ids)
        self.assertTrue({
            "wikiNavDrawer", "wikiNavBtn", "wikiNavTree", "wikiImageInsertFile",
            "wikiHomeStandards", "wikiHomeResourcesBody", "wikiAdminStandards",
            "wikiAdminExternalResources", "wikiAdminAddResourceBtn", "wikiAdminMediaPanel",
            "wikiAdminMediaGrid", "wikiAdminMediaInput", "wikiAdminContentPanel",
            "wikiAdminEditorOnlyBtn", "wikiAdminSplitViewBtn", "wikiAdminPreviewOnlyBtn",
            "wikiSearchSubmitBtn", "wikiViewBtn", "wikiReturnBtn", "wikiPageStandardsList",
            "wikiAdminAddStandardBtn", "wikiAdminStandardsCsvInput", "wikiAdminPageStandards",
            "wikiSiteFooter", "wikiAdminFooterText", "wikiAdminFolderIcon",
            "wikiEmojiPickerModal", "studentNotebookWikiLinkBtn", "studentNotebookWikiLinkModal",
            "wikiStandardsCoverageBtn", "wikiStandardsCoveragePanel", "wikiCoverageFolderFilter",
            "wikiCoverageTableBody", "wikiCoverageHomeBtn", "wikiCoveragePrintBtn",
            "wikiCoverageTitle", "wikiCoveragePrintMeta", "wikiCoverageClassLegend",
            "wikiAdminPageStandardsSearch", "wikiAdminPageStandardsSelectedBtn",
            "wikiAdminPageStandardsClearBtn", "wikiAdminPageStandardsSummary",
            "wikiAdminPageStandardsNoMatches", "wikiFontSizeSelect",
            "wikiReaderShell", "wikiStandardDescriptionTooltip",
            "fileArtifactPreview", "fileArtifactPreviewImage", "fileArtifactDatabaseInfo",
            "fileArtifactDatabaseTable", "fileArtifactDatabaseRefresh",
            "fileArtifactDatabaseStatus", "fileArtifactDatabaseTableWrap",
            "fileArtifactDatabaseHead", "fileArtifactDatabaseBody", "fileArtifactDatabaseNote",
            "aiTimeoutInputModal", "aiTestBtn", "aiTestStatus",
            "teacherShellDebugMessages", "adminShellDebugMessages",
            "guestIdeAccessEnabledModal",
            "teacherNotebookSkillSearch", "teacherNotebookSkillSummary",
            "teacherNotebookSelectVisibleSkills", "teacherNotebookClearSkills",
            "pythonContainmentStatus", "pythonMemoryLimitModal",
            "pythonConcurrencyLimitModal", "pythonModuleAccessList",
            "pythonSecurityLockedModules", "pythonRuntimeRefreshBtn",
        }.issubset(ids))
        self.assertNotIn("wikiHomeTree", ids)
        self.assertIn('accept=".png,.jpg,.jpeg,.webp,.gif"', self.raw)
        self.assertIn('accept=".csv,text/csv"', self.raw)
        self.assertIn('accept=".py,.js,.html,.css,.txt,.csv,.json,.md,.png,.jpg,.jpeg,.gif,.webp,.db,.sqlite,.sqlite3"', self.raw)

    def test_wiki_home_order_and_class_management_surfaces(self):
        ids = set(self.parser.ids)
        self.assertLess(self.raw.index('id="wikiFeaturedSection"'), self.raw.index('id="wikiHomeStandards"'))
        self.assertNotIn("wikiHomeBookmarksSection", ids)
        self.assertTrue({
            "student-dash-classes", "joinClassCodeInput", "studentClassMembershipList",
            "adminUsersRoleFilter", "settingsOpenWikiManagerBtn", "settingsOpenWikiHomeBtn",
        }.issubset(ids))
        self.assertNotIn("lessonUrlInputModal", ids)
        self.assertNotIn("lessonUseLocalModal", ids)
        self.assertNotIn('class="cls-wiki-url"', self.raw)

    def test_lesson_plan_surfaces_and_print_layout_are_wired(self):
        ids = set(self.parser.ids)
        self.assertTrue({
            "studentLessonPlanSection", "studentLessonPlanHost", "lessonPlanTeacherHost",
            "lessonPlanWikiPickerModal", "lessonPlanWikiPickerTree",
            "lessonPlanExternalLinkModal", "lessonPlanExternalLinkUrl",
        }.issubset(ids))
        self.assertIn('data-view="dash-lesson-plans"', self.raw)
        self.assertIn('/static/js/lesson-plan-renderer.js?v=20260805-1', self.raw)
        self.assertIn('/static/js/lesson-plans.js?v=20260805-1', self.raw)
        css = (BASE_DIR / "static" / "css" / "features" / "lesson-plans.css").read_text(encoding="utf-8")
        self.assertIn("overflow-y:auto", css.replace(" ", ""))
        self.assertIn("@page { size:landscape", css)
        self.assertIn("body.lesson-plan-public-page .lesson-plan-standard-row span", css)
        self.assertIn("display:none !important", css)
        self.assertIn("position:fixed", css)
        self.assertIn("grid-template-columns:repeat(2,minmax(0,1fr))", css.replace(" ", ""))
        self.assertIn(".lesson-plan-standard-overflow", css)
        controller = (BASE_DIR / "static" / "js" / "lesson-plans.js").read_text(encoding="utf-8")
        self.assertIn("fetchJson('/api/wiki/tree')", controller)
        self.assertNotIn("/api/wiki/search?q=", controller)
        self.assertIn("window.location.origin", controller)
        self.assertIn("const isTeacher = !!ctx.TEACHER_TOKEN", controller)
        self.assertIn("/lesson-plans/${encodeURIComponent(state.teacherWeek)}/print", controller)
        self.assertIn("lessonPlanTeacherSource", controller)
        self.assertIn("/api/teacher/lesson-plans/link-preview", controller)
        self.assertIn("external_links", controller)
        renderer = (BASE_DIR / "static" / "js" / "lesson-plan-renderer.js").read_text(encoding="utf-8")
        self.assertIn("lesson-plan-standard-more", renderer)
        self.assertIn("item.external_links", renderer)
        public_script = (BASE_DIR / "static" / "js" / "lesson-plan-public.js").read_text(encoding="utf-8")
        self.assertIn("/api/lesson-plans/print/", public_script)
        public_html = (BASE_DIR / "lesson_plan_public.html").read_text(encoding="utf-8")
        self.assertIn('id="publicLessonPlanHost"', public_html)
        self.assertIn('class="lesson-plan-site-header"', public_html)
        self.assertIn('/static/js/lesson-plan-public.js?v=20260805-1', public_html)

    def test_teacher_notebook_shell_and_challenge_controls_are_wired(self):
        core = (BASE_DIR / "static" / "js" / "app-core.js").read_text(encoding="utf-8")
        notebook = (BASE_DIR / "static" / "js" / "student-notebook.js").read_text(encoding="utf-8")
        self.assertIn("SHELL_DEBUG_MESSAGE_PATTERN", core)
        self.assertIn("challenges_enabled", core)
        self.assertIn("guest_ide_access_enabled", core)
        self.assertIn("student_ide_access_enabled", core)
        self.assertIn("X-Class-ID", core)
        self.assertIn("skill.description", notebook)
        self.assertIn("teacherNotebookSelectedSkills", notebook)
        self.assertNotIn("open-class-bookmarks-btn", core)

    def test_ide_search_does_not_force_wiki_mode_and_hides_contents_toggle(self):
        reader = (BASE_DIR / "static" / "js" / "wiki-reader.js").read_text(encoding="utf-8")
        wiki_css = (BASE_DIR / "static" / "css" / "features" / "wiki.css").read_text(encoding="utf-8")
        self.assertNotIn("wikiSearchInput')?.addEventListener('focus'", reader)
        self.assertIn("wikiViewBtn')?.addEventListener('click'", reader)
        self.assertIn("body:not(.wiki-mode) #wikiNavBtn", wiki_css)
        self.assertIn("body:not(.wiki-mode) #ideViewBtn", wiki_css)
        self.assertIn("#wikiEmojiPickerModal { z-index: 10200; }", wiki_css)
        self.assertIn("--wiki-nav-drawer-width", wiki_css)
        self.assertIn("flex: 0 0 38px", wiki_css)
        self.assertIn("setTimeout(renderPreview, 500)", (BASE_DIR / "static" / "js" / "wiki-admin.js").read_text(encoding="utf-8"))
        self.assertIn("&limit=8", reader)
        self.assertIn("setTimeout(() => performSearch(event.target.value), 300)", reader)
        self.assertIn("localStorage.setItem(WIKI_FONT_SIZE_KEY", reader)
        self.assertIn("clearSearchHighlights", reader)
        self.assertIn("showStandardsCoverage", reader)
        self.assertIn("style.setProperty('font-size', `${size}px`, 'important')", reader)
        self.assertIn("showStandardDescriptionTooltip", reader)
        self.assertNotIn("Not yet covered", reader)
        self.assertIn("returnToWiki", reader)
        self.assertIn("sessionStorage.setItem(WIKI_RETURN_KEY", reader)
        self.assertIn("wiki-coverage-pages", reader)
        self.assertNotIn("openClassAction('bookmark'", reader)
        self.assertIn("bookmark.hidden = !isStudent()", reader)
        self.assertIn("Feature content for a class", reader)
        admin = (BASE_DIR / "static" / "js" / "wiki-admin.js").read_text(encoding="utf-8")
        self.assertIn("addEventListener('paste', pasteClipboardImages)", admin)
        self.assertIn("align: 'center'", admin)
        self.assertIn("width: 'original'", admin)
        self.assertIn("|align=${placement}|width=${scale}", admin)
        self.assertIn('@app.get("/standards-coverage")', (BASE_DIR / "app.py").read_text(encoding="utf-8"))
        self.assertLess(self.raw.index('id="wikiPageStandards"'), self.raw.index('id="wikiTocContents"'))
        app_core = (BASE_DIR / "static" / "js" / "app-core.js").read_text(encoding="utf-8")
        self.assertIn("/api/admin/python-runtime", app_core)
        self.assertIn("/api/files/preview", app_core)
        self.assertIn("/api/files/database-preview", app_core)
        self.assertIn("/api/files/wiki-example", app_core)
        self.assertIn("/api/admin/ai/test", app_core)
        self.assertIn("artifact-preview-active", app_core)
        self.assertIn("socket.on('run_artifacts'", app_core)

    def test_network_simulator_surfaces_are_modular_and_touch_ready(self):
        ids = set(self.parser.ids)
        self.assertTrue({
            "networkViewBtn", "networkView", "networkLibrary", "networkWorkspace",
            "networkDevicePalette", "networkCanvas", "networkInspector",
            "networkPacketResult", "networkCliForm", "networkObjectivesPanel",
            "networkPacketTargetLabel", "networkPacketPortLabel", "networkPacketDomainLabel",
            "networkPacketDomain", "networkPacketOverlayLayer", "networkPortPicker",
            "networkInspectorResizer", "networkConsoleResizer",
            "networkTeacherClassSelect", "networkTeacherAccessToggle",
            "networkTeacherLabList", "networkSimEnabledModal", "networkCommandModal",
            "networkReferencePanel", "networkDiagnosticsPanel", "networkCapturePanel",
            "networkSimulationPanel", "networkTrafficToggleBtn",
            "wikiHeroNetworkBtn", "wikiHomeBtn",
        }.issubset(ids))
        script = (BASE_DIR / "static" / "js" / "network-sim.js").read_text(encoding="utf-8")
        advanced_script = (BASE_DIR / "static" / "js" / "network-sim-advanced.js").read_text(encoding="utf-8")
        worker_script = (BASE_DIR / "static" / "js" / "network-sim-worker.js").read_text(encoding="utf-8")
        css = (BASE_DIR / "static" / "css" / "features" / "network-sim.css").read_text(encoding="utf-8")
        app_source = (BASE_DIR / "app.py").read_text(encoding="utf-8")
        self.assertIn("pointerdown", script)
        self.assertIn('value="dhcp">DHCP Discover', self.raw)
        self.assertIn("DHCPDISCOVER", script)
        self.assertIn("Automatic (DHCP)", script)
        self.assertIn("networkDhcpRequestBtn", script)
        self.assertIn("dhcp_dns_primary", script)
        self.assertIn("DEVICE_PORTS", script)
        self.assertIn("simulateWebRequest", script)
        self.assertIn("DNS + HTTP Request", self.raw)
        self.assertIn("networkPacketPlayBtn", script)
        self.assertIn("▶ Play loop", script)
        self.assertIn("state.packetStep >= steps.length - 1 ? 0", script)
        self.assertIn("topologySuggestions", script)
        self.assertIn("prepareDirectAddressInputs", script)
        self.assertIn("referenceMarkup", script)
        self.assertIn("port_reference", script)
        self.assertIn("acronym_reference", script)
        self.assertIn("wirelessAssociations", script)
        self.assertIn("network-link--wireless", script)
        self.assertIn("network-link--speed-very-fast", css)
        self.assertIn("new Worker", advanced_script)
        self.assertIn("rogue-dhcp", worker_script)
        self.assertIn("if (running) start()", worker_script)
        self.assertIn("network-sim:topology-opened", script)
        self.assertIn("stpCacheRevision", script)
        self.assertIn("saveInFlight", script)
        self.assertNotIn("state.topology = saved", script)
        self.assertNotIn("return pendingSave;\n    renderCommandReference", script)
        self.assertNotIn("networkMinimap", self.raw)
        self.assertNotIn("networkMinimap", advanced_script)
        self.assertNotIn("network-minimap", css)
        self.assertNotIn("networkAvailableIps", script)
        self.assertNotIn("networkGateways", script)
        self.assertNotIn("networkDnsChoices", script)
        self.assertIn("data-switch-port-mode", script)
        self.assertIn("data-route-field", script)
        self.assertIn("data-firewall-interface-field", script)
        self.assertIn("data-address-list", script)
        self.assertIn("window.EagleIDE?.configReady", script)
        self.assertIn("requestBootstrap", script)
        self.assertIn("previousForm && device && previousForm.dataset.inspectorDevice", script)
        self.assertIn(".network-link.is-selected", script)
        self.assertIn("state.selectedLinkId === linkId ? '' : linkId", script)
        self.assertIn("$('networkCanvas')?.addEventListener('pointerdown'", script)
        self.assertIn("labelInspectorSections", script)
        self.assertIn("window.addEventListener('pagehide', stopPacketPlayback)", script)
        self.assertIn("network-packet-token", script)
        self.assertIn("data-server-interface-field", script)
        self.assertIn("network-student-progress", script)
        self.assertIn("setupPanelResizers", script)
        self.assertIn("Layer 3 Switch", script)
        self.assertIn("data-acl-field", script)
        self.assertIn("networkResetDeviceBtn", script)
        self.assertIn("data-teacher-demo-lab", script)
        self.assertIn("is-blocked-hop", script)
        self.assertIn("data-connect-port", script)
        self.assertIn("touch-action: none", css)
        self.assertIn("@media (pointer: coarse)", css)
        self.assertIn("body.network-mode", css)
        self.assertIn('id="wikiHomeBtn" type="button">Wiki Home</button>', self.raw)
        self.assertIn('id="wikiHeroNetworkBtn"', self.raw)
        app_core = (BASE_DIR / "static" / "js" / "app-core.js").read_text(encoding="utf-8")
        self.assertIn("window.EagleIDE.configReady = loadConfig()", app_core)
        self.assertIn('@app.get("/network")', app_source)
        self.assertIn("register_network_features", app_source)


if __name__ == "__main__":
    unittest.main()
