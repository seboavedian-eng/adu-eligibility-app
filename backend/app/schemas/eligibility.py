from typing import Any, Literal

from pydantic import BaseModel


CheckStatus = Literal["PASS", "FAIL", "REVIEW", "REDESIGN", "INFO"]
Severity = Literal["BLOCKER", "WARNING", "INFO"]
OverallStatus = Literal[
    "likely_eligible",
    "eligible_if_redesigned",
    "needs_survey_zoning_review",
    "not_eligible",
]
AduType = Literal[
    "WHOLLY_BASEMENT",
    "ATTACHED_OR_WITHIN_MAIN_HOUSE_NOT_BASEMENT",
    "EXISTING_DETACHED_STRUCTURE_CONVERSION",
    "NEW_DETACHED_STRUCTURE",
]


class ParcelData(BaseModel):
    zoning_code: str | None = None
    zoning_description: str | None = None
    lot_area_sqft: float | None = None
    parcel_id: str | None = None
    estimated_building_height_ft: float | None = None
    main_building_footprint_sqft: float | None = None
    accessory_building_footprint_sqft: float | None = None
    driveway_area_sqft: float | None = None
    estimated_existing_coverage_sqft: float | None = None


class UserAnswers(BaseModel):
    is_owner: bool | None = None
    has_qualifying_main_dwelling: bool | None = None
    has_existing_adu: bool | None = None
    has_family_caregiver_suite: bool | None = None
    adu_type: AduType | None = None
    basement_size: float | None = None
    adu_gfa: float | None = None
    main_gfa: float | None = None
    has_egress_confirmed: bool | None = None
    detached_built_before_may_18_2019: bool | None = None
    detached_build_date_unknown: bool | None = None
    work_within_existing_exterior_walls: bool | None = None
    entrance_above_first_floor: bool | None = None
    exterior_stairs_face_street: bool | None = None
    existing_off_street_spaces: int | None = None
    fronts_cul_de_sac: bool | None = None
    block_parking_occupancy_under_65_percent: bool | None = None
    can_create_one_parking_space: bool | None = None
    will_maintain_existing_parking_spaces: bool | None = None
    will_maintain_at_least_two_spaces: bool | None = None
    adu_occupants: int | None = None
    owner_will_live_in_main_or_adu: bool | None = None
    entire_property_occupied_by_one_family: bool | None = None


class LeadData(BaseModel):
    email: str | None = None
    name: str | None = None


class EligibilityRequest(BaseModel):
    parcel: ParcelData
    answers: UserAnswers
    lead: LeadData | None = None


class RuleResult(BaseModel):
    check_name: str
    status: CheckStatus
    severity: Severity
    message: str
    source_rule: str
    evidence: dict[str, Any] = {}


class ComputedOptions(BaseModel):
    max_adu_gfa_sqft: float | None = None
    max_detached_footprint_sqft: float | None = None
    max_detached_height_ft: float = 25
    max_detached_stories: float = 1.5
    lot_coverage_limit_percent: float | None = None
    estimated_existing_coverage_percent: float | None = None
    estimated_remaining_coverage_sqft: float | None = None
    preliminary_max_detached_footprint_sqft: float | None = None


class EligibilityResponse(BaseModel):
    status: OverallStatus
    headline: str
    blockers: list[str]
    redesign_items: list[str]
    review_items: list[str]
    passed_checks: list[str]
    recommendations: list[str]
    permit_checklist: list[str]
    limitations: list[str]
    computed_options: ComputedOptions
    rule_results: list[RuleResult]
