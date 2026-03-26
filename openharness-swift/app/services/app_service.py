"""
App Generation Service — orchestrates spec → code → sentinel → eval gate.

Python port of src/launch/pipeline.ts + codegen.ts + spec-generator.ts,
with the same sentinel and eval gates integrated.
"""
from __future__ import annotations
import re
import time
import uuid
from typing import Optional

from ..models.schemas import (
    AppSpec, FeatureSpec, ScreenSpec, DataModelSpec, DesignSystemSpec,
    EntitySpec, PropertySpec, GeneratedFile, GeneratedProject,
    StageResult, PipelineResult, PipelineStage,
    Platform, Priority, ScreenType, Persistence, PropType,
)
from ..security import SentinelPipeline, AuditLedger

# ─── Swift Identifier Sanitization ────────────────────────────────

SWIFT_RESERVED = frozenset({
    "class", "struct", "enum", "protocol", "func", "var", "let", "import",
    "return", "if", "else", "for", "while", "switch", "case", "break",
    "continue", "default", "do", "try", "catch", "throw", "guard", "self",
    "Self", "nil", "true", "false", "as", "is", "in", "where",
    "init", "deinit", "static", "override", "private", "public", "internal",
})

def _safe_id(name: str) -> str:
    clean = re.sub(r"[^a-zA-Z0-9_]", "", name)
    if not clean or clean[0].isdigit():
        clean = f"_{clean}"
    if clean in SWIFT_RESERVED:
        clean = f"`{clean}`"
    return clean

def _safe_type_name(name: str) -> str:
    s = _safe_id(name)
    return s[:1].upper() + s[1:] if s else "Entity"

# ─── Mock Spec Generator ──────────────────────────────────────────

def generate_mock_spec(description: str) -> AppSpec:
    words = description.split()[:3]
    name = " ".join(words) if words else "My App"
    slug = re.sub(r"[^a-z0-9]", "", name.lower())

    return AppSpec(
        id=str(uuid.uuid4()),
        name=name,
        bundleId=f"com.privatelaunch.{slug}",
        description=description,
        platforms=[Platform.ios],
        features=[
            FeatureSpec(name="Main List", description="Browse items", priority=Priority.must, screens=["main_list"]),
            FeatureSpec(name="Detail View", description="View item details", priority=Priority.must, screens=["detail"]),
            FeatureSpec(name="Add Item", description="Create new items", priority=Priority.must, screens=["add_form"]),
        ],
        dataModel=DataModelSpec(
            entities=[EntitySpec(
                name="Item",
                properties=[
                    PropertySpec(name="title", type=PropType.string, optional=False),
                    PropertySpec(name="notes", type=PropType.string, optional=True),
                    PropertySpec(name="createdAt", type=PropType.date, optional=False),
                    PropertySpec(name="isCompleted", type=PropType.bool, optional=False, defaultValue="false"),
                ],
            )],
            persistence=Persistence.swiftdata,
        ),
        screens=[
            ScreenSpec(id="main_list", name="Items", type=ScreenType.list, components=["NavigationStack", "List"], navigatesTo=["detail", "add_form"]),
            ScreenSpec(id="detail", name="Item Detail", type=ScreenType.detail, components=["ScrollView"], navigatesTo=[]),
            ScreenSpec(id="add_form", name="Add Item", type=ScreenType.form, components=["Form", "TextField"], navigatesTo=[]),
            ScreenSpec(id="settings", name="Settings", type=ScreenType.settings, components=["Form", "Toggle"], navigatesTo=[]),
        ],
        designSystem=DesignSystemSpec(),
        createdAt=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    )

# ─── Swift Code Generator ─────────────────────────────────────────

def _map_type(t: PropType, optional: bool) -> str:
    m = {"string": "String", "int": "Int", "double": "Double", "bool": "Bool", "date": "Date", "data": "Data", "enum": "String"}
    base = m.get(t.value, "String")
    return f"{base}?" if optional else base

def _format_default(t: PropType, val: str) -> str:
    if t == PropType.string:
        safe = val.replace("\\", "\\\\").replace('"', '\\"')
        return f'"{safe}"'
    if t == PropType.bool:
        return "true" if val.lower() in ("true", "1", "yes") else "false"
    if t in (PropType.int, PropType.double):
        return val if re.match(r"^-?\d+\.?\d*$", val) else "0"
    if t == PropType.date:
        return "Date()"
    return f'"{val}"'

def generate_swift_code(spec: AppSpec) -> list[GeneratedFile]:
    project = spec.name.replace(" ", "").replace("-", "")
    files: list[GeneratedFile] = []

    # App entry point
    has_entities = bool(spec.data_model and spec.data_model.entities)
    mc = ""
    if has_entities:
        names = ", ".join(f"{_safe_type_name(e.name)}.self" for e in spec.data_model.entities)
        mc = f"\n            .modelContainer(for: [{names}])"
    files.append(GeneratedFile(
        path=f"{project}/{project}App.swift",
        content=f"""import SwiftUI
{"import SwiftData" if has_entities else ""}

@main
struct {project}App: App {{
    var body: some Scene {{
        WindowGroup {{
            ContentView(){mc}
        }}
    }}
}}
""",
        language="swift",
    ))

    # Models
    if has_entities:
        models = []
        for entity in spec.data_model.entities:
            ename = _safe_type_name(entity.name)
            props = []
            for p in entity.properties:
                pname = _safe_id(p.name)
                ptype = _map_type(p.type, p.optional)
                default = ""
                if p.default_value:
                    default = f" = {_format_default(p.type, p.default_value)}"
                elif p.optional:
                    default = " = nil"
                props.append(f"    var {pname}: {ptype}{default}")

            init_params = [f"{_safe_id(p.name)}: {_map_type(p.type, False)}"
                           for p in entity.properties if not p.optional and not p.default_value]
            init_body = [f"        self.{_safe_id(p.name)} = {_safe_id(p.name)}"
                         for p in entity.properties if not p.optional and not p.default_value]

            models.append(f"""@Model
final class {ename} {{
{chr(10).join(props)}

    init({", ".join(init_params)}) {{
{chr(10).join(init_body)}
    }}
}}""")

        files.append(GeneratedFile(
            path=f"{project}/Models/Models.swift",
            content="import Foundation\nimport SwiftData\n\n" + "\n\n".join(models) + "\n",
            language="swift",
        ))

    # ContentView
    main_screen = next((s for s in spec.screens if s.type in (ScreenType.list, ScreenType.dashboard)), spec.screens[0] if spec.screens else None)
    main_view = main_screen.name.replace(" ", "") + "View" if main_screen else "Text(\"Hello\")"
    has_settings = any(s.type == ScreenType.settings for s in spec.screens)

    if has_settings:
        body = f"""    var body: some View {{
        TabView {{
            {main_view}()
                .tabItem {{ Label("{main_screen.name if main_screen else "Home"}", systemImage: "house") }}
            SettingsView()
                .tabItem {{ Label("Settings", systemImage: "gear") }}
        }}
    }}"""
    else:
        body = f"    var body: some View {{ {main_view}() }}"

    mc_preview = ""
    if has_entities:
        names = ", ".join(f"{_safe_type_name(e.name)}.self" for e in spec.data_model.entities)
        mc_preview = f"\n        .modelContainer(for: [{names}], inMemory: true)"

    files.append(GeneratedFile(
        path=f"{project}/ContentView.swift",
        content=f"""import SwiftUI

struct ContentView: View {{
{body}
}}

#Preview {{
    ContentView(){mc_preview}
}}
""",
        language="swift",
    ))

    # Views (simplified — one per screen)
    for screen in spec.screens:
        view_name = screen.name.replace(" ", "") + "View"
        if screen.type == ScreenType.settings:
            view_body = '    var body: some View { Form { Section("About") { Text("Built with PrivateLaunch") } }.navigationTitle("Settings") }'
        elif screen.type == ScreenType.list and has_entities:
            ename = _safe_type_name(spec.data_model.entities[0].name)
            view_body = f"""    @Query private var items: [{ename}]
    var body: some View {{
        NavigationStack {{
            List(items) {{ item in Text(String(describing: item)) }}
                .navigationTitle("{spec.name}")
        }}
    }}"""
        else:
            view_body = f'    var body: some View {{ Text("{screen.name}").navigationTitle("{screen.name}") }}'

        files.append(GeneratedFile(
            path=f"{project}/Views/{view_name}.swift",
            content=f"""import SwiftUI
{"import SwiftData" if has_entities else ""}

struct {view_name}: View {{
{view_body}
}}

#Preview {{ {view_name}() }}
""",
            language="swift",
        ))

    return files

# ─── Pipeline Orchestrator ─────────────────────────────────────────

class AppPipeline:
    def __init__(self, sentinel: SentinelPipeline, audit: AuditLedger):
        self.sentinel = sentinel
        self.audit = audit

    async def run(self, description: str) -> tuple[Optional[GeneratedProject], PipelineResult]:
        app_id = str(uuid.uuid4())
        stages: list[StageResult] = []

        # Stage 1: Spec
        start = time.monotonic()
        try:
            spec = generate_mock_spec(description)
            stages.append(StageResult(stage=PipelineStage.spec_generation, success=True, durationMs=_elapsed(start)))
        except Exception as e:
            stages.append(StageResult(stage=PipelineStage.spec_generation, success=False, error=str(e), durationMs=_elapsed(start)))
            return None, PipelineResult(appId=app_id, stages=stages, success=False, totalMs=_total(stages))

        self.audit.record("launch:spec_generated", spec.name, "success", {"features": len(spec.features)})

        # Stage 2: Codegen
        start = time.monotonic()
        try:
            files = generate_swift_code(spec)
            stages.append(StageResult(stage=PipelineStage.code_generation, success=True, durationMs=_elapsed(start)))
        except Exception as e:
            stages.append(StageResult(stage=PipelineStage.code_generation, success=False, error=str(e), durationMs=_elapsed(start)))
            return None, PipelineResult(appId=app_id, stages=stages, success=False, totalMs=_total(stages))

        self.audit.record("launch:code_generated", spec.name, "success", {"files": len(files)})

        # Stage 3: Sentinel
        start = time.monotonic()
        for f in files:
            if f.language != "swift":
                continue
            result = self.sentinel.inspect(f.content)
            if result.threat_level == "blocked":
                msg = "; ".join(fd.description for fd in result.findings)
                stages.append(StageResult(stage=PipelineStage.sentinel_check, success=False, error=f"Blocked in {f.path}: {msg}", durationMs=_elapsed(start)))
                self.audit.record("launch:sentinel_block", f.path, "blocked", {"findings": len(result.findings)})
                return None, PipelineResult(appId=app_id, stages=stages, success=False, totalMs=_total(stages))
        stages.append(StageResult(stage=PipelineStage.sentinel_check, success=True, durationMs=_elapsed(start)))

        # Stage 4: L1 eval (code quality)
        start = time.monotonic()
        all_code = "\n".join(f.content for f in files if f.language == "swift")
        issues = _check_code_quality(all_code)
        if issues:
            stages.append(StageResult(stage=PipelineStage.test, success=False, error="; ".join(issues), durationMs=_elapsed(start)))
            return None, PipelineResult(appId=app_id, stages=stages, success=False, totalMs=_total(stages))
        stages.append(StageResult(stage=PipelineStage.test, success=True, durationMs=_elapsed(start)))

        project = GeneratedProject(spec=spec, files=files, xcodeProjectPath=f"{spec.name.replace(' ', '')}/{spec.name.replace(' ', '')}.xcodeproj")
        self.audit.record("launch:pipeline_complete", spec.name, "success", {"files": len(files), "stages": len(stages)})

        return project, PipelineResult(appId=app_id, stages=stages, success=True, totalMs=_total(stages))


def _elapsed(start: float) -> float:
    return round((time.monotonic() - start) * 1000, 2)

def _total(stages: list[StageResult]) -> float:
    return sum(s.duration_ms for s in stages)

def _check_code_quality(code: str) -> list[str]:
    """L1-equivalent code quality checks."""
    issues = []
    if re.search(r"\beval\s*\(", code):
        issues.append("eval() detected in generated code")
    if re.search(r"(?:sk-|AKIA|ghp_)[a-zA-Z0-9]{10,}", code):
        issues.append("Hardcoded credential in generated code")
    if re.search(r"\b\d{3}-\d{2}-\d{4}\b", code):
        issues.append("SSN pattern in generated code")
    return issues
