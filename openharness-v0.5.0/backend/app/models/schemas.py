"""
OpenHarness API Models — Pydantic v2 schemas for all endpoints.

Mirrors the TypeScript types from src/launch/types.ts and src/evals/*.ts
with Python-native validation.
"""
from __future__ import annotations
from datetime import datetime
from enum import Enum
from typing import Optional
from pydantic import BaseModel, Field, field_validator
import re

# ─── Enums ────────────────────────────────────────────────────────

class Platform(str, Enum):
    ios = "ios"
    macos = "macos"
    watchos = "watchos"
    visionos = "visionos"

class Priority(str, Enum):
    must = "must"
    should = "should"
    could = "could"

class ScreenType(str, Enum):
    list = "list"
    detail = "detail"
    form = "form"
    settings = "settings"
    dashboard = "dashboard"
    onboarding = "onboarding"
    tab = "tab"

class PropType(str, Enum):
    string = "string"
    int = "int"
    double = "double"
    bool = "bool"
    date = "date"
    data = "data"
    enum = "enum"

class Persistence(str, Enum):
    swiftdata = "swiftdata"
    coredata = "coredata"
    userdefaults = "userdefaults"

class ColorScheme(str, Enum):
    adaptive = "adaptive"
    light = "light"
    dark = "dark"

class ThreatLevel(str, Enum):
    safe = "safe"
    suspicious = "suspicious"
    blocked = "blocked"

class PipelineStage(str, Enum):
    spec_generation = "spec_generation"
    code_generation = "code_generation"
    sentinel_check = "sentinel_check"
    build = "build"
    test = "test"
    preview_capture = "preview_capture"
    icon_generation = "icon_generation"
    metadata_generation = "metadata_generation"
    archive = "archive"
    signing = "signing"
    upload = "upload"

class Role(str, Enum):
    admin = "admin"
    operator = "operator"
    auditor = "auditor"
    user = "user"

class AgeRating(str, Enum):
    four_plus = "4+"
    nine_plus = "9+"
    twelve_plus = "12+"
    seventeen_plus = "17+"

# ─── App Spec Models ──────────────────────────────────────────────

class PropertySpec(BaseModel):
    name: str = Field(..., min_length=1, max_length=64)
    type: PropType
    optional: bool = False
    default_value: Optional[str] = Field(None, alias="defaultValue")
    enum_values: Optional[list[str]] = Field(None, alias="enumValues")

    @field_validator("name")
    @classmethod
    def validate_identifier(cls, v: str) -> str:
        clean = re.sub(r"[^a-zA-Z0-9_]", "", v)
        if not clean or clean[0].isdigit():
            clean = f"_{clean}"
        return clean

class EntitySpec(BaseModel):
    name: str = Field(..., min_length=1, max_length=64)
    properties: list[PropertySpec] = Field(default_factory=list)

    @field_validator("name")
    @classmethod
    def validate_entity_name(cls, v: str) -> str:
        clean = re.sub(r"[^a-zA-Z0-9_]", "", v)
        if not clean or clean[0].isdigit():
            clean = f"_{clean}"
        return clean[:1].upper() + clean[1:]

class RelationshipSpec(BaseModel):
    from_entity: str = Field(..., alias="from")
    to_entity: str = Field(..., alias="to")
    type: str
    name: str

class DataModelSpec(BaseModel):
    entities: list[EntitySpec] = Field(default_factory=list)
    relationships: list[RelationshipSpec] = Field(default_factory=list)
    persistence: Persistence = Persistence.swiftdata

class FeatureSpec(BaseModel):
    name: str
    description: str
    priority: Priority = Priority.should
    screens: list[str] = Field(default_factory=list)

class ScreenSpec(BaseModel):
    id: str
    name: str
    type: ScreenType = ScreenType.list
    components: list[str] = Field(default_factory=list)
    navigates_to: list[str] = Field(default_factory=list, alias="navigatesTo")

class DesignSystemSpec(BaseModel):
    color_scheme: ColorScheme = Field(ColorScheme.adaptive, alias="colorScheme")
    accent_color: str = Field("#007AFF", alias="accentColor")
    font_style: str = Field("system", alias="fontStyle")
    icon_style: str = Field("sf-symbols", alias="iconStyle")

class AppSpec(BaseModel):
    id: Optional[str] = None
    name: str = Field(..., min_length=1, max_length=100)
    bundle_id: str = Field(..., alias="bundleId", min_length=5)
    description: str = Field(..., min_length=10)
    platforms: list[Platform] = Field(default_factory=lambda: [Platform.ios])
    features: list[FeatureSpec] = Field(..., min_length=1)
    data_model: DataModelSpec = Field(default_factory=DataModelSpec, alias="dataModel")
    screens: list[ScreenSpec] = Field(..., min_length=1)
    design_system: DesignSystemSpec = Field(default_factory=DesignSystemSpec, alias="designSystem")
    created_at: Optional[str] = Field(None, alias="createdAt")

    model_config = {"populate_by_name": True}

# ─── Pipeline Models ──────────────────────────────────────────────

class StageResult(BaseModel):
    stage: PipelineStage
    success: bool
    duration_ms: float = Field(0, alias="durationMs")
    output: Optional[str] = None
    error: Optional[str] = None
    artifacts: list[str] = Field(default_factory=list)

class PipelineResult(BaseModel):
    app_id: str = Field(..., alias="appId")
    stages: list[StageResult]
    success: bool
    total_ms: float = Field(0, alias="totalMs")
    ipa_path: Optional[str] = Field(None, alias="ipaPath")

    model_config = {"populate_by_name": True}

class GeneratedFile(BaseModel):
    path: str
    content: str
    language: str

class GeneratedProject(BaseModel):
    spec: AppSpec
    files: list[GeneratedFile]
    xcode_project_path: str = Field("", alias="xcodeProjectPath")

    model_config = {"populate_by_name": True}

# ─── Sentinel Models ──────────────────────────────────────────────

class ThreatFinding(BaseModel):
    category: str
    confidence: float = Field(..., ge=0, le=100)
    description: str
    matched_pattern: Optional[str] = Field(None, alias="matchedPattern")

class InspectionResult(BaseModel):
    threat_level: ThreatLevel = Field(..., alias="threatLevel")
    findings: list[ThreatFinding]
    latency_ms: float = Field(0, alias="latencyMs")

    model_config = {"populate_by_name": True}

# ─── Eval Models ──────────────────────────────────────────────────

class L1Result(BaseModel):
    name: str
    passed: bool
    reason: Optional[str] = None
    duration_ms: float = Field(0, alias="durationMs")

class L1SuiteResult(BaseModel):
    passed: bool
    assertions: list[L1Result]
    fail_count: int = Field(0, alias="failCount")
    total_ms: float = Field(0, alias="totalMs")

    model_config = {"populate_by_name": True}

class ExperimentConfig(BaseModel):
    id: str
    hypothesis: str
    target_file: str = Field(..., alias="targetFile")
    time_budget_ms: int = Field(30000, alias="timeBudgetMs")
    primary_metric_name: str = Field(..., alias="primaryMetricName")
    baseline_metric: float = Field(..., alias="baselineMetric")
    l2_pass_rate: float = Field(0.85, alias="l2PassRate")

    model_config = {"populate_by_name": True}

class ExperimentResult(BaseModel):
    experiment_id: str = Field(..., alias="experimentId")
    hypothesis: str
    timestamp: str
    l1: L1SuiteResult
    primary_metric: float = Field(..., alias="primaryMetric")
    baseline_metric: float = Field(..., alias="baselineMetric")
    metric_improved: bool = Field(..., alias="metricImproved")
    all_gates_passed: bool = Field(..., alias="allGatesPassed")
    decision: str
    revert_reason: Optional[str] = Field(None, alias="revertReason")
    total_ms: float = Field(0, alias="totalMs")

    model_config = {"populate_by_name": True}

# ─── Auth Models ──────────────────────────────────────────────────

class UserCreate(BaseModel):
    username: str = Field(..., min_length=3, max_length=50)
    password: str = Field(..., min_length=8)
    role: Role = Role.user

class UserResponse(BaseModel):
    id: str
    username: str
    role: Role
    created_at: str

class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"

# ─── Request Models ───────────────────────────────────────────────

class GenerateAppRequest(BaseModel):
    description: str = Field(..., min_length=10, max_length=2000)

class InspectContentRequest(BaseModel):
    content: str = Field(..., min_length=1, max_length=65536)
    source: str = Field("user_message", pattern=r'^[a-zA-Z0-9_\-]{1,64}$')

class AuditQueryRequest(BaseModel):
    since: Optional[str] = None
    before: Optional[str] = None
    type_filter: Optional[str] = None
    limit: int = Field(100, ge=1, le=1000)

# ─── Response Models ──────────────────────────────────────────────

class HealthResponse(BaseModel):
    status: str
    version: str
    uptime_seconds: float
    store_ok: bool
    sentinel_active: bool
    audit_chain_valid: bool

class AppListResponse(BaseModel):
    apps: list[dict]
    total: int

class AuditEntry(BaseModel):
    id: str
    timestamp: str
    type: str
    user_id: Optional[str] = None
    target: str
    outcome: str
    details: dict = Field(default_factory=dict)
