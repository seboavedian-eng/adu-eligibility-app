from app.schemas.eligibility import ComputedOptions, EligibilityRequest, EligibilityResponse, RuleResult

ARLINGTON_ADU_SOURCE = "Arlington ADU rewrite specification based on current product spec. Final approval requires Arlington County review."
ELIGIBLE_ZONES = {"R-20", "R-10", "R-10T", "R-8", "R-6", "R-5", "R15-30T", "R2-7"}
LOT_COVERAGE_MAX = {
    "R-5": 0.45,
    "R15-30T": 0.45,
    "R-6": 0.40,
    "R2-7": 0.40,
    "R-8": 0.35,
    "R-10": 0.32,
    "R-10T": 0.32,
    "R-20": 0.25,
}

PERMIT_CHECKLIST = [
    "Accessory Dwelling Permit application",
    "Residential Building Permit",
    "Floor plan of ADU and relationship to main dwelling",
    "Certified plat of lot",
    "Site plan showing existing and proposed improvements",
    "Parking evidence if required",
    "Declaration of Covenants before building permit approval",
    "Affidavit of Compliance before Certificate of Occupancy",
    "Owner agreement to annual inspections and compliance obligations",
]

LIMITATIONS = [
    "Certified setbacks require survey confirmation.",
    "Right-of-way, legal parking count, and nonconforming structure status may require zoning review.",
    "GIS lot coverage is an estimate and may differ from certified plat calculations.",
    "Building-code egress, fire separation, utilities, stormwater, and historic constraints are not fully verified here.",
]


def get_max_adu_gfa(main_gfa: float | None) -> float | None:
    if not main_gfa or main_gfa <= 0:
        return None
    if main_gfa >= 1000:
        return min(750, 0.5384615 * main_gfa)
    return min(500, 0.8181818 * main_gfa)


def get_max_detached_footprint(zoning_code: str | None) -> int:
    return 560 if zoning_code in {"R-5", "R-6"} else 650


def _check(check_name: str, status: str, severity: str, message: str, evidence: dict | None = None) -> RuleResult:
    return RuleResult(
        check_name=check_name,
        status=status,
        severity=severity,
        message=message,
        source_rule=ARLINGTON_ADU_SOURCE,
        evidence=evidence or {},
    )


def _bool_check(value: bool | None, fail_message: str, pass_message: str, review_message: str) -> RuleResult:
    if value is True:
        return _check(pass_message, "PASS", "INFO", pass_message)
    if value is False:
        return _check(fail_message, "FAIL", "BLOCKER", fail_message)
    return _check(review_message, "REVIEW", "WARNING", review_message)


def check_eligibility(payload: EligibilityRequest) -> EligibilityResponse:
    parcel = payload.parcel
    answers = payload.answers
    checks: list[RuleResult] = []
    recommendations: list[str] = []

    options = _computed_options(parcel, answers)

    _run_core(parcel, answers, checks)
    if not _has_blocker(checks):
        _run_branch(parcel, answers, checks, recommendations, options)
        _run_parking(answers, checks)
        _run_article3(parcel, answers, checks, options)
        _run_occupancy(answers, checks)

    blockers = [c.message for c in checks if c.status == "FAIL" and c.severity == "BLOCKER"]
    redesign_items = [c.message for c in checks if c.status == "REDESIGN"]
    review_items = [c.message for c in checks if c.status == "REVIEW"]
    passed_checks = [c.message for c in checks if c.status == "PASS"]
    status, headline = _classify(blockers, redesign_items, review_items)

    return EligibilityResponse(
        status=status,
        headline=headline,
        blockers=blockers,
        redesign_items=redesign_items,
        review_items=review_items,
        passed_checks=passed_checks,
        recommendations=recommendations,
        permit_checklist=PERMIT_CHECKLIST if status != "not_eligible" else [],
        limitations=LIMITATIONS,
        computed_options=options,
        rule_results=checks,
    )


def _computed_options(parcel, answers) -> ComputedOptions:
    coverage_limit = LOT_COVERAGE_MAX.get(parcel.zoning_code)
    existing_coverage = parcel.estimated_existing_coverage_sqft
    remaining_coverage = None
    existing_coverage_percent = None

    if parcel.lot_area_sqft and coverage_limit:
        allowed_coverage = parcel.lot_area_sqft * coverage_limit
        if existing_coverage is not None:
            remaining_coverage = max(0, allowed_coverage - existing_coverage)
            existing_coverage_percent = existing_coverage / parcel.lot_area_sqft

    max_footprint = get_max_detached_footprint(parcel.zoning_code)
    preliminary_max = max_footprint
    if remaining_coverage is not None:
        preliminary_max = min(max_footprint, remaining_coverage)

    return ComputedOptions(
        max_adu_gfa_sqft=get_max_adu_gfa(answers.main_gfa),
        max_detached_footprint_sqft=max_footprint,
        lot_coverage_limit_percent=coverage_limit,
        estimated_existing_coverage_percent=existing_coverage_percent,
        estimated_remaining_coverage_sqft=remaining_coverage,
        preliminary_max_detached_footprint_sqft=preliminary_max,
    )


def _run_core(parcel, answers, checks: list[RuleResult]) -> None:
    if not parcel.zoning_code:
        checks.append(_check("zoning", "REVIEW", "WARNING", "Search an Arlington address so zoning can be checked."))
    elif parcel.zoning_code in ELIGIBLE_ZONES:
        checks.append(_check("zoning", "PASS", "INFO", "Zoning district is eligible for ADU review.", {"zoning_code": parcel.zoning_code}))
    else:
        checks.append(_check("zoning", "FAIL", "BLOCKER", "Zoning district is not eligible for an accessory dwelling.", {"zoning_code": parcel.zoning_code}))

    checks.append(_bool_check(answers.is_owner, "Applicant must be the property owner.", "Applicant owner status passes.", "Owner/applicant status must be confirmed."))
    checks.append(_bool_check(answers.has_qualifying_main_dwelling, "Property must have a qualifying main dwelling.", "Qualifying main dwelling passes.", "Qualifying main dwelling status must be confirmed."))

    if answers.has_existing_adu is True:
        checks.append(_check("existing_adu", "FAIL", "BLOCKER", "Only one accessory dwelling is allowed per lot."))
    elif answers.has_existing_adu is False:
        checks.append(_check("existing_adu", "PASS", "INFO", "No existing ADU was reported."))
    else:
        checks.append(_check("existing_adu", "REVIEW", "WARNING", "Existing ADU status must be confirmed."))

    if answers.has_family_caregiver_suite is True:
        checks.append(_check("family_caregiver_suite", "FAIL", "BLOCKER", "Accessory dwelling is not allowed on a lot with a family/caregiver suite."))
    elif answers.has_family_caregiver_suite is False:
        checks.append(_check("family_caregiver_suite", "PASS", "INFO", "No family/caregiver suite was reported."))
    else:
        checks.append(_check("family_caregiver_suite", "REVIEW", "WARNING", "Family/caregiver suite status must be confirmed."))


def _run_branch(parcel, answers, checks, recommendations, options) -> None:
    if not answers.adu_type:
        checks.append(_check("adu_type", "REVIEW", "WARNING", "ADU type is required."))
        return

    if answers.adu_type == "WHOLLY_BASEMENT":
        _run_basement(answers, checks, recommendations)
    elif answers.adu_type == "ATTACHED_OR_WITHIN_MAIN_HOUSE_NOT_BASEMENT":
        _run_attached(answers, checks, recommendations)
    elif answers.adu_type == "EXISTING_DETACHED_STRUCTURE_CONVERSION":
        _run_existing_detached(parcel, answers, checks, recommendations)
    elif answers.adu_type == "NEW_DETACHED_STRUCTURE":
        _run_new_detached(parcel, answers, checks, recommendations, options)


def _run_basement(answers, checks, recommendations) -> None:
    if answers.basement_size is None:
        checks.append(_check("basement_size", "REVIEW", "WARNING", "Basement size is required."))
    elif answers.adu_gfa is None:
        checks.append(_check("basement_size", "PASS", "INFO", "Basement ADU size will be treated as up to the basement size."))
    elif answers.adu_gfa > answers.basement_size:
        checks.append(_check("basement_size", "REDESIGN", "WARNING", "Basement ADU cannot exceed basement size."))
    else:
        checks.append(_check("basement_size", "PASS", "INFO", "Basement ADU size passes zoning size check."))

    if answers.has_egress_confirmed is True:
        checks.append(_check("egress", "PASS", "INFO", "Emergency egress was confirmed by user."))
    else:
        checks.append(_check("egress", "REVIEW", "WARNING", "Building-code egress must be confirmed."))
    recommendations.append("Basement path: zoning size cap equals basement size; building-code egress still needs permit review.")


def _run_attached(answers, checks, recommendations) -> None:
    _run_gfa(answers, checks)
    _run_stair(answers, checks, is_pre_2019_detached=False)
    max_gfa = get_max_adu_gfa(answers.main_gfa)
    if max_gfa:
        recommendations.append(f"Maximum attached/non-basement ADU GFA based on entered main dwelling GFA: {int(max_gfa)} sq. ft.")


def _run_existing_detached(parcel, answers, checks, recommendations) -> None:
    if answers.detached_build_date_unknown is True or answers.detached_built_before_may_18_2019 is None:
        checks.append(_check("detached_build_date", "REVIEW", "WARNING", "Detached structure build date is critical and must be confirmed."))
    elif answers.detached_built_before_may_18_2019 is False:
        _run_new_detached(parcel, answers, checks, recommendations, _computed_options(parcel, answers))
        return
    else:
        if answers.work_within_existing_exterior_walls is True:
            checks.append(_check("pre_2019_conversion", "PASS", "INFO", "Pre-2019 detached conversion may qualify for the interior alteration path."))
        else:
            checks.append(_check("pre_2019_conversion", "REVIEW", "WARNING", "Exterior expansion may require Article 16/nonconformity review."))

    _run_gfa(answers, checks)
    _run_stair(answers, checks, is_pre_2019_detached=True)
    recommendations.append("Existing detached conversion path may be more flexible if the structure predates May 18, 2019 and work stays inside the existing envelope.")


def _run_new_detached(parcel, answers, checks, recommendations, options) -> None:
    checks.append(_check("detached_footprint_option", "INFO", "INFO", f"Maximum detached footprint option: {int(options.max_detached_footprint_sqft or 0)} sq. ft."))
    checks.append(_check("detached_height_option", "INFO", "INFO", "Maximum detached height option: 25 ft and 1.5 stories."))
    _run_gfa(answers, checks)
    _run_stair(answers, checks, is_pre_2019_detached=False)
    recommendations.append("New detached path: use the map envelope as a preliminary siting area, then confirm setbacks and lot coverage by survey.")


def _run_gfa(answers, checks) -> None:
    max_allowed = get_max_adu_gfa(answers.main_gfa)
    if max_allowed is None:
        checks.append(_check("adu_gfa", "REVIEW", "WARNING", "Main dwelling GFA is required to evaluate ADU size."))
        return
    if answers.adu_gfa is None:
        checks.append(_check("adu_gfa", "PASS", "INFO", f"No proposed ADU GFA entered; using the maximum allowed estimate of {int(max_allowed)} sq. ft."))
    elif answers.adu_gfa > max_allowed:
        checks.append(_check("adu_gfa", "REDESIGN", "WARNING", f"Proposed ADU GFA exceeds the maximum allowed. Reduce to {int(max_allowed)} sq. ft. or less."))
    else:
        checks.append(_check("adu_gfa", "PASS", "INFO", f"ADU GFA is within the estimated {int(max_allowed)} sq. ft. limit."))


def _run_stair(answers, checks, is_pre_2019_detached: bool) -> None:
    if answers.entrance_above_first_floor is False:
        checks.append(_check("street_facing_stairs", "PASS", "INFO", "No above-first-floor entrance stair issue."))
    elif answers.entrance_above_first_floor is None:
        checks.append(_check("street_facing_stairs", "REVIEW", "WARNING", "Entrance level must be confirmed."))
    elif answers.exterior_stairs_face_street is True and not is_pre_2019_detached:
        checks.append(_check("street_facing_stairs", "REDESIGN", "WARNING", "Exterior stairs to an above-first-floor ADU entrance cannot be street-facing."))
    elif answers.exterior_stairs_face_street is None:
        checks.append(_check("street_facing_stairs", "REVIEW", "WARNING", "Street-facing stair location must be confirmed."))
    else:
        checks.append(_check("street_facing_stairs", "PASS", "INFO", "Exterior stair location passes."))


def _run_parking(answers, checks) -> None:
    spaces = answers.existing_off_street_spaces
    if spaces is None:
        checks.append(_check("parking", "REVIEW", "WARNING", "Existing legal off-street parking count is required."))
        return
    if spaces == 0:
        if answers.block_parking_occupancy_under_65_percent is True:
            checks.append(_check("parking", "PASS", "INFO", "No new parking required if County survey confirms block occupancy under 65%."))
        elif answers.can_create_one_parking_space is True:
            checks.append(_check("parking", "PASS", "INFO", "One new off-street space can be created if required."))
        elif answers.can_create_one_parking_space is False:
            checks.append(_check("parking", "FAIL", "BLOCKER", "No existing parking and required new parking cannot be created."))
        else:
            checks.append(_check("parking", "REVIEW", "WARNING", "Zero existing spaces requires County parking survey or one creatable off-street space."))
    elif spaces == 1:
        if answers.will_maintain_existing_parking_spaces is True:
            checks.append(_check("parking", "PASS", "INFO", "Existing one parking space will be maintained."))
        else:
            checks.append(_check("parking", "FAIL", "BLOCKER", "Existing required parking space must be maintained."))
    else:
        if answers.will_maintain_at_least_two_spaces is True:
            checks.append(_check("parking", "PASS", "INFO", "At least two existing parking spaces will be maintained."))
        else:
            checks.append(_check("parking", "FAIL", "BLOCKER", "At least two existing parking spaces must be maintained."))


def _run_article3(parcel, answers, checks, options) -> None:
    if answers.adu_type != "NEW_DETACHED_STRUCTURE":
        return
    if options.estimated_remaining_coverage_sqft is None:
        checks.append(_check("lot_coverage", "REVIEW", "WARNING", "Lot coverage needs review because GIS coverage estimate is incomplete."))
    elif options.estimated_remaining_coverage_sqft <= 0:
        checks.append(_check("lot_coverage", "REDESIGN", "WARNING", "Estimated lot coverage leaves no remaining area for new detached ADU coverage."))
    else:
        checks.append(_check("lot_coverage", "PASS", "INFO", f"Estimated remaining lot coverage capacity: {int(options.estimated_remaining_coverage_sqft)} sq. ft."))
    checks.append(_check("detached_setbacks", "REVIEW", "WARNING", "Detached setbacks and ROW lines must be confirmed by survey."))


def _run_occupancy(answers, checks) -> None:
    if answers.adu_occupants is None:
        checks.append(_check("adu_occupants", "REVIEW", "WARNING", "ADU occupant count is required."))
    elif answers.adu_occupants > 3:
        checks.append(_check("adu_occupants", "FAIL", "BLOCKER", "No more than three people may occupy the ADU."))
    else:
        checks.append(_check("adu_occupants", "PASS", "INFO", "ADU occupant count passes."))

    if answers.owner_will_live_in_main_or_adu is True:
        checks.append(_check("owner_occupancy", "PASS", "INFO", "Owner occupancy condition passes."))
    elif answers.entire_property_occupied_by_one_family is True:
        checks.append(_check("owner_occupancy", "PASS", "INFO", "Owner not occupying, but entire property occupancy is limited to one family."))
    elif answers.owner_will_live_in_main_or_adu is None:
        checks.append(_check("owner_occupancy", "REVIEW", "WARNING", "Owner occupancy plan must be confirmed."))
    else:
        checks.append(_check("owner_occupancy", "FAIL", "BLOCKER", "Owner occupancy / one-family property occupancy condition is not met."))


def _has_blocker(checks: list[RuleResult]) -> bool:
    return any(c.status == "FAIL" and c.severity == "BLOCKER" for c in checks)


def _classify(blockers: list[str], redesign_items: list[str], review_items: list[str]) -> tuple[str, str]:
    if blockers:
        return "not_eligible", "Not Eligible"
    if redesign_items:
        return "eligible_if_redesigned", "Eligible if Redesigned"
    if review_items:
        return "needs_survey_zoning_review", "Needs Survey / Zoning Review"
    return "likely_eligible", "Likely Eligible"
