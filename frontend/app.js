const API_BASE = "http://127.0.0.1:8000";

const parcelState = {
  zoning_code: null,
  zoning_description: null,
  lot_area_sqft: null,
  parcel_id: null,
  estimated_building_height_ft: null,
  main_building_footprint_sqft: null,
  accessory_building_footprint_sqft: null,
  driveway_area_sqft: null,
  estimated_existing_coverage_sqft: null,
};

const geometryState = {
  parcel: null,
  buildings: [],
  driveways: [],
  envelope: null,
};

let currentStep = 0;
let arcgis = {};
let lastLoadedAddress = "";
let lastRejectedAddress = "";

function boolValue(name) {
  const selected = document.querySelector(`input[name="${name}"]:checked`);
  if (!selected) return null;
  if (selected.value === "true") return true;
  if (selected.value === "false") return false;
  return null;
}

function radioValue(name) {
  const selected = document.querySelector(`input[name="${name}"]:checked`);
  return selected ? selected.value : null;
}

function numberValue(id) {
  const element = document.getElementById(id);
  if (!element || element.value === "") return null;
  return Number(element.value);
}

function setText(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = value || "N/A";
}

function setStatus(message) {
  const status = document.getElementById("addressLoadStatus");
  if (status) status.textContent = message;
}

function showStep(step) {
  const steps = [...document.querySelectorAll(".wizard-step")];
  currentStep = Math.max(0, Math.min(step, steps.length - 1));
  steps.forEach((section, index) => section.classList.toggle("active", index === currentStep));
  const onLastStep = currentStep === steps.length - 1;
  document.getElementById("progressBar").style.width = `${((currentStep + 1) / steps.length) * 100}%`;
  document.getElementById("backButton").disabled = currentStep === 0;
  document.getElementById("nextButton").classList.toggle("hidden", onLastStep);
  document.getElementById("resetButton").classList.toggle("hidden", !onLastStep);
  document.getElementById("emailFindingsButton").classList.toggle("hidden", !onLastStep);
  hideInfoTooltip();
}

function selectedAduType() {
  return radioValue("aduType");
}

function updateBranchFields() {
  const type = selectedAduType();
  document.getElementById("basementFields").classList.toggle("hidden", type !== "WHOLLY_BASEMENT");
  document.getElementById("attachedFields").classList.toggle("hidden", type !== "ATTACHED_OR_WITHIN_MAIN_HOUSE_NOT_BASEMENT");
  document.getElementById("existingDetachedFields").classList.toggle("hidden", type !== "EXISTING_DETACHED_STRUCTURE_CONVERSION");
  document.getElementById("newDetachedFields").classList.toggle("hidden", type !== "NEW_DETACHED_STRUCTURE");
  updateOptionSummary();
}

function updateFollowups() {
  document.getElementById("attachedStairFollowup").classList.toggle("hidden", boolValue("entranceAboveFirstFloorAttached") !== true);
  document.getElementById("detachedStairFollowup").classList.toggle("hidden", boolValue("entranceAboveFirstFloorDetached") !== true);

  const spaces = numberValue("existingOffStreetSpaces");
  document.getElementById("zeroParkingFollowup").classList.toggle("hidden", spaces !== 0);
  document.getElementById("oneParkingFollowup").classList.toggle("hidden", spaces !== 1);
  document.getElementById("twoParkingFollowup").classList.toggle("hidden", spaces === null || spaces < 2);
  document.getElementById("oneFamilyFollowup").classList.toggle("hidden", boolValue("ownerWillLiveInMainOrAdu") !== false);
}

function getMaxDetachedFootprint() {
  if (!parcelState.zoning_code) return null;
  return ["R-5", "R-6"].includes(parcelState.zoning_code) ? 560 : 650;
}

function getCoverageLimit() {
  const limits = {
    "R-5": 0.45,
    "R15-30T": 0.45,
    "R-6": 0.4,
    "R2-7": 0.4,
    "R-8": 0.35,
    "R-10": 0.32,
    "R-10T": 0.32,
    "R-20": 0.25,
  };
  return limits[parcelState.zoning_code] || null;
}

function getRemainingCoverage() {
  const limit = getCoverageLimit();
  if (!limit || !parcelState.lot_area_sqft || parcelState.estimated_existing_coverage_sqft == null) return null;
  return Math.max(0, parcelState.lot_area_sqft * limit - parcelState.estimated_existing_coverage_sqft);
}

function updateOptionSummary() {
  const maxFootprint = getMaxDetachedFootprint();
  const summary = document.getElementById("optionSummary");
  const detachedText = document.getElementById("detachedOptionText");
  if (!summary && !detachedText) return;

  if (!parcelState.parcel_id || !parcelState.zoning_code) {
    const waitingText = "Search an Arlington address first to calculate property-specific ADU options.";
    if (summary) summary.innerHTML = `<strong>Auto-calculated options</strong><p>${waitingText}</p>`;
    if (detachedText) detachedText.textContent = waitingText;
    return;
  }

  const remaining = getRemainingCoverage();
  const preliminary = remaining == null ? maxFootprint : Math.min(maxFootprint, remaining);
  const coverageLimit = getCoverageLimit();
  const text = [
    `Max detached footprint: ${maxFootprint} sq ft`,
    "Max detached height: 25 ft",
    "Max detached stories: 1.5",
    coverageLimit ? `Base lot coverage cap: ${Math.round(coverageLimit * 100)}%` : "Lot coverage cap: needs zoning",
    `Preliminary max detached footprint from coverage: ${Math.floor(preliminary)} sq ft`,
  ];
  if (summary) summary.innerHTML = `<strong>Auto-calculated options</strong><p>${text.join("<br>")}</p>`;
  if (detachedText) detachedText.innerHTML = text.join("<br>");
}

function resetForNewAddress() {
  Object.keys(parcelState).forEach((key) => {
    parcelState[key] = null;
  });
  geometryState.parcel = null;
  geometryState.buildings = [];
  geometryState.driveways = [];
  geometryState.envelope = null;
  clearWizardInputs();
  document.getElementById("resultCard").classList.add("hidden");
  setText("zoningCode", null);
  setText("lotArea", null);
  setText("parcelID", null);
  setText("coverageEstimate", null);
  document.getElementById("addressLoadStatus").textContent = "No address loaded yet.";
  const zoningDescription = document.getElementById("zoningDescription");
  if (zoningDescription) zoningDescription.textContent = "Description: N/A";
  updateBranchFields();
  updateFollowups();
  showStep(0);
  setStatus("Loading new address...");
  if (arcgis.view) arcgis.view.graphics.removeAll();
}

function clearWizardInputs() {
  document.querySelectorAll("#eligibilityForm input").forEach((input) => {
    if (input.closest("#addressSearchHost")) return;
    if (input.type === "radio" || input.type === "checkbox") {
      input.checked = false;
    } else {
      input.value = "";
    }
  });
}

function collectAnswers() {
  const type = selectedAduType();
  const mainGfa =
    type === "ATTACHED_OR_WITHIN_MAIN_HOUSE_NOT_BASEMENT" ? numberValue("mainGfaAttached") :
    type === "EXISTING_DETACHED_STRUCTURE_CONVERSION" ? numberValue("mainGfaExistingDetached") :
    type === "NEW_DETACHED_STRUCTURE" ? numberValue("mainGfaNewDetached") :
    null;
  const aduGfa =
    type === "WHOLLY_BASEMENT" ? numberValue("aduGfaBasement") :
    type === "ATTACHED_OR_WITHIN_MAIN_HOUSE_NOT_BASEMENT" ? numberValue("aduGfaAttached") :
    type === "EXISTING_DETACHED_STRUCTURE_CONVERSION" ? numberValue("aduGfaExistingDetached") :
    type === "NEW_DETACHED_STRUCTURE" ? numberValue("aduGfaNewDetached") :
    null;
  const maxAduGfa = getMaxAduGfa(mainGfa);
  const effectiveAduGfa = aduGfa || maxAduGfa;

  const detachedBuilt = radioValue("detachedBuiltBefore");
  const isDetached = type === "NEW_DETACHED_STRUCTURE" || type === "EXISTING_DETACHED_STRUCTURE_CONVERSION";

  return {
    is_owner: boolValue("isOwner"),
    has_qualifying_main_dwelling: boolValue("hasQualifyingMainDwelling"),
    has_existing_adu: boolValue("hasExistingAdu"),
    has_family_caregiver_suite: boolValue("hasFamilyCaregiverSuite"),
    adu_type: type,
    basement_size: numberValue("basementSize"),
    adu_gfa: effectiveAduGfa,
    main_gfa: mainGfa,
    has_egress_confirmed: boolValue("hasEgressConfirmed"),
    detached_built_before_may_18_2019: detachedBuilt === "unknown" ? null : boolValue("detachedBuiltBefore"),
    detached_build_date_unknown: detachedBuilt === "unknown",
    work_within_existing_exterior_walls: boolValue("workWithinExistingWalls"),
    entrance_above_first_floor: isDetached ? boolValue("entranceAboveFirstFloorDetached") : boolValue("entranceAboveFirstFloorAttached"),
    exterior_stairs_face_street: isDetached ? boolValue("exteriorStairsFaceStreetDetached") : boolValue("exteriorStairsFaceStreetAttached"),
    existing_off_street_spaces: numberValue("existingOffStreetSpaces"),
    fronts_cul_de_sac: boolValue("frontsCulDeSac"),
    can_create_one_parking_space: boolValue("canCreateOneParkingSpace"),
    will_maintain_existing_parking_spaces: boolValue("willMaintainExistingParkingSpaces"),
    will_maintain_at_least_two_spaces: boolValue("willMaintainAtLeastTwoSpaces"),
    adu_occupants: numberValue("aduOccupants"),
    owner_will_live_in_main_or_adu: boolValue("ownerWillLiveInMainOrAdu"),
    entire_property_occupied_by_one_family: boolValue("entirePropertyOccupiedByOneFamily"),
  };
}

function getMaxAduGfa(mainGfa) {
  if (!mainGfa || mainGfa <= 0) return null;
  if (mainGfa >= 1000) return Math.min(750, 0.5384615 * mainGfa);
  return Math.min(500, 0.8181818 * mainGfa);
}

function hasRadioAnswer(name) {
  return Boolean(document.querySelector(`input[name="${name}"]:checked`));
}

function validateCurrentStep() {
  const type = selectedAduType();
  const spaces = numberValue("existingOffStreetSpaces");
  const checks = {
    0: [
      Boolean(parcelState.parcel_id && parcelState.zoning_code),
      Boolean(document.getElementById("leadName").value.trim()),
      Boolean(document.getElementById("leadEmail").value.trim()),
    ],
    1: ["isOwner", "hasQualifyingMainDwelling", "hasExistingAdu", "hasFamilyCaregiverSuite"].map(hasRadioAnswer),
    2: [hasRadioAnswer("aduType")],
    3: validateProjectStep(type),
    4: [
      spaces !== null,
      hasRadioAnswer("frontsCulDeSac"),
      spaces === 0 ? hasRadioAnswer("canCreateOneParkingSpace") : true,
      spaces === 1 ? hasRadioAnswer("willMaintainExistingParkingSpaces") : true,
      spaces !== null && spaces >= 2 ? hasRadioAnswer("willMaintainAtLeastTwoSpaces") : true,
    ],
    5: [
      numberValue("aduOccupants") !== null,
      hasRadioAnswer("ownerWillLiveInMainOrAdu"),
      boolValue("ownerWillLiveInMainOrAdu") === false ? hasRadioAnswer("entirePropertyOccupiedByOneFamily") : true,
    ],
  }[currentStep] || [true];

  const valid = checks.every(Boolean);
  if (!valid) showValidationBubble("Please answer the required fields before continuing.");
  return valid;
}

function showValidationBubble(message) {
  const bubble = document.getElementById("validationBubble");
  bubble.textContent = message;
  bubble.classList.remove("hidden");
  window.clearTimeout(showValidationBubble.timeoutId);
  showValidationBubble.timeoutId = window.setTimeout(() => bubble.classList.add("hidden"), 2600);
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function runEligibilityProgress() {
  const panel = document.getElementById("eligibilityProgress");
  const bar = document.getElementById("eligibilityProgressBar");
  const text = document.getElementById("eligibilityProgressText");
  const messages = [
    "Validating the selected Arlington address...",
    "Reading parcel and zoning records...",
    "Checking building and parking constraints...",
    "Reviewing ADU eligibility rules...",
  ];
  const duration = 3000 + Math.random() * 2000;
  const start = performance.now();

  panel.classList.remove("hidden");
  bar.style.width = "0%";
  text.textContent = messages[0];

  await new Promise((resolve) => {
    function tick(now) {
      const progress = Math.min((now - start) / duration, 1);
      const percent = Math.round(progress * 100);
      const messageIndex = Math.min(messages.length - 1, Math.floor(progress * messages.length));
      bar.style.width = `${percent}%`;
      text.textContent = messages[messageIndex];
      if (progress < 1) {
        window.requestAnimationFrame(tick);
      } else {
        text.textContent = "Review completed.";
        resolve();
      }
    }
    window.requestAnimationFrame(tick);
  });

  await sleep(350);
}

function isArlingtonAddressText(address) {
  const text = String(address || "").toLowerCase();
  return /\barlington\b/.test(text) && (/\bva\b/.test(text) || /\bvirginia\b/.test(text));
}

function showArlingtonOnlyMessage() {
  showValidationBubble("We currently support Arlington, VA only.");
  setStatus("We currently support Arlington, VA only. Please select an Arlington address.");
}

function resetApplication() {
  lastLoadedAddress = "";
  lastRejectedAddress = "";
  resetForNewAddress();
  const input = document.querySelector("#addressSearchHost input");
  if (input) input.value = "";
  setStatus("No address loaded yet.");
  document.getElementById("resultCard").classList.add("hidden");
  document.getElementById("eligibilityProgress").classList.add("hidden");
  document.getElementById("eligibilityProgressBar").style.width = "0%";
}

function emailFindings() {
  const email = document.getElementById("leadEmail").value.trim();
  const card = document.getElementById("resultCard");
  if (!email) {
    showValidationBubble("Enter your email first.");
    return;
  }
  if (card.classList.contains("hidden") || !card.innerText.trim()) {
    showValidationBubble("Run the eligibility check first.");
    return;
  }
  const subject = encodeURIComponent("Brickline ADU findings");
  const body = encodeURIComponent(card.innerText.trim());
  window.location.href = `mailto:${email}?subject=${subject}&body=${body}`;
}

function validateProjectStep(type) {
  if (type === "WHOLLY_BASEMENT") {
    return [
      numberValue("basementSize") !== null,
      hasRadioAnswer("hasEgressConfirmed"),
    ];
  }
  if (type === "ATTACHED_OR_WITHIN_MAIN_HOUSE_NOT_BASEMENT") {
    const above = boolValue("entranceAboveFirstFloorAttached");
    return [
      numberValue("mainGfaAttached") !== null,
      hasRadioAnswer("entranceAboveFirstFloorAttached"),
      above === true ? hasRadioAnswer("exteriorStairsFaceStreetAttached") : true,
    ];
  }
  if (type === "EXISTING_DETACHED_STRUCTURE_CONVERSION") {
    return [
      hasRadioAnswer("detachedBuiltBefore"),
      hasRadioAnswer("workWithinExistingWalls"),
      numberValue("mainGfaExistingDetached") !== null,
    ];
  }
  if (type === "NEW_DETACHED_STRUCTURE") {
    const above = boolValue("entranceAboveFirstFloorDetached");
    return [
      numberValue("mainGfaNewDetached") !== null,
      hasRadioAnswer("entranceAboveFirstFloorDetached"),
      above === true ? hasRadioAnswer("exteriorStairsFaceStreetDetached") : true,
    ];
  }
  return [false];
}

function renderList(label, items) {
  if (!items || !items.length) return "";
  return `<strong>${label}</strong><ul>${items.map((item) => `<li>${item}</li>`).join("")}</ul>`;
}

function renderResult(result, envelopeResult) {
  const card = document.getElementById("resultCard");
  const reason = result.blockers?.[0] || result.redesign_items?.[0] || result.review_items?.[0] || result.passed_checks?.[0] || "The entered information passed the current rules screen.";
  const options = result.computed_options || {};
  const parcelFacts = [
    parcelState.zoning_code ? `Zone: ${parcelState.zoning_code}` : null,
    parcelState.zoning_description ? `${parcelState.zoning_description}` : null,
    parcelState.parcel_id ? `Parcel: ${parcelState.parcel_id}` : null,
    parcelState.lot_area_sqft ? `Lot area: ${parcelState.lot_area_sqft.toLocaleString()} sq ft` : null,
    parcelState.estimated_existing_coverage_sqft && parcelState.lot_area_sqft
      ? `Estimated coverage: ${Math.round((parcelState.estimated_existing_coverage_sqft / parcelState.lot_area_sqft) * 100)}%`
      : null,
  ].filter(Boolean);
  const optionLines = [
    options.max_adu_gfa_sqft ? `Max ADU GFA from entered main GFA: ${Math.floor(options.max_adu_gfa_sqft)} sq ft` : null,
    options.max_detached_footprint_sqft ? `Max detached footprint: ${Math.floor(options.max_detached_footprint_sqft)} sq ft` : null,
    options.estimated_remaining_coverage_sqft != null ? `Estimated remaining lot coverage: ${Math.floor(options.estimated_remaining_coverage_sqft)} sq ft` : null,
    envelopeResult?.status === "PRELIMINARY_CANDIDATE_FOUND" ? `Map envelope area: about ${Math.floor(envelopeResult.areaSqft)} sq ft` : null,
  ].filter(Boolean);

  card.innerHTML = `
    <span class="pill ${result.status}">${result.status.replaceAll("_", " ")}</span>
    <h2>${result.headline}</h2>
    <p class="result-reason">${reason}</p>
    <p class="muted">Preliminary zoning screen only. Final ADU eligibility requires Arlington County zoning review, permit approval, certified plat/survey confirmation, and building-code review.</p>
    ${renderList("Property Snapshot", parcelFacts)}
    ${renderList("Computed Options", optionLines)}
    ${renderList("Blockers", result.blockers)}
    ${renderList("Redesign Items", result.redesign_items)}
    ${renderList("Review Items", result.review_items)}
    ${renderList("Passed Checks", result.passed_checks)}
    ${renderList("Recommendations", result.recommendations)}
    ${envelopeResult ? renderList("ADU Envelope", envelopeSummary(envelopeResult)) : ""}
    ${renderList("Permit Checklist", result.permit_checklist)}
    ${renderList("Known Limitations", result.limitations)}
  `;
  card.classList.remove("hidden");
}

function envelopeSummary(envelopeResult) {
  if (envelopeResult.status !== "PRELIMINARY_CANDIDATE_FOUND") {
    return [envelopeResult.reason || "No preliminary detached envelope found."];
  }
  return [
    `Preliminary candidate found with centroid ${envelopeResult.centroid.map((n) => n.toFixed(6)).join(", ")}.`,
    `Coordinates: ${envelopeResult.coordinates.slice(0, 4).map((pair) => `[${pair.map((n) => n.toFixed(6)).join(", ")}]`).join(" ")}`,
    "Certified survey, ROW, eave, and lot coverage confirmation required.",
  ];
}

function geometryAreaSqft(geometry) {
  if (!geometry || !arcgis.geometryEngine) return 0;
  return Math.abs(arcgis.geometryEngine.geodesicArea(geometry, "square-feet"));
}

function addGraphic(geometry, color, outline) {
  arcgis.view.graphics.add(new arcgis.Graphic({
    geometry,
    symbol: {
      type: "simple-fill",
      color,
      outline,
    },
  }));
}

function drawBaseGraphics() {
  arcgis.view.graphics.removeAll();
  if (geometryState.parcel) {
    addGraphic(geometryState.parcel, [15, 139, 111, 0.18], { color: [15, 139, 111], width: 2 });
  }
  geometryState.driveways.forEach((geometry) => addGraphic(geometry, [58, 123, 213, 0.2], { color: [58, 123, 213], width: 2 }));
  geometryState.buildings.forEach((geometry) => addGraphic(geometry, [245, 150, 63, 0.24], { color: [245, 150, 63], width: 2 }));
}

function computeDetachedEnvelope(result) {
  if (selectedAduType() !== "NEW_DETACHED_STRUCTURE") return null;
  if (result.status === "not_eligible") return null;
  if (!geometryState.parcel || !arcgis.geometryEngine) {
    return { status: "NO_PRELIMINARY_DETACHED_ENVELOPE_FOUND", reason: "Parcel geometry is not available." };
  }

  let candidate = arcgis.geometryEngine.geodesicBuffer(geometryState.parcel, -5, "feet");
  if (!candidate || candidate.isEmpty) {
    return { status: "NO_PRELIMINARY_DETACHED_ENVELOPE_FOUND", reason: "Parcel boundary buffer eliminates available area." };
  }

  geometryState.buildings.forEach((building) => {
    const buffered = arcgis.geometryEngine.geodesicBuffer(building, 8, "feet");
    const diff = arcgis.geometryEngine.difference(candidate, buffered);
    if (diff && !diff.isEmpty) candidate = diff;
  });

  geometryState.driveways.forEach((driveway) => {
    const diff = arcgis.geometryEngine.difference(candidate, driveway);
    if (diff && !diff.isEmpty) candidate = diff;
  });

  if (!candidate || candidate.isEmpty) {
    return { status: "NO_PRELIMINARY_DETACHED_ENVELOPE_FOUND", reason: "Setbacks, buildings, or driveway preservation eliminate available detached area." };
  }

  const areaSqft = geometryAreaSqft(candidate);
  const maxFootprint = result.computed_options?.preliminary_max_detached_footprint_sqft || getMaxDetachedFootprint();
  if (areaSqft < Math.min(200, maxFootprint)) {
    return { status: "NO_PRELIMINARY_DETACHED_ENVELOPE_FOUND", reason: "Remaining candidate area appears too small for a practical detached ADU." };
  }

  drawBaseGraphics();
  addGraphic(candidate, [255, 214, 64, 0.42], { color: [204, 154, 0], width: 3 });
  geometryState.envelope = candidate;

  const ring = candidate.rings?.[0] || [];
  const coordinates = ring.map((point) => arcgis.webMercatorUtils.xyToLngLat(point[0], point[1]));
  const centroid = arcgis.webMercatorUtils.xyToLngLat(candidate.centroid.x, candidate.centroid.y);
  return {
    status: "PRELIMINARY_CANDIDATE_FOUND",
    maxPreliminaryFootprintSqFt: Math.min(maxFootprint, areaSqft),
    areaSqft,
    coordinates,
    centroid,
  };
}

async function submitEligibility() {
  const button = document.getElementById("checkEligibilityButton");

  if (!parcelState.parcel_id || !parcelState.zoning_code) {
    showValidationBubble("Search and select an Arlington address first.");
    return;
  }

  button.disabled = true;
  button.textContent = "Checking...";
  document.getElementById("resultCard").classList.add("hidden");
  const progressPromise = runEligibilityProgress();

  try {
    const responsePromise = fetch(`${API_BASE}/api/check-eligibility`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        parcel: parcelState,
        answers: collectAnswers(),
        lead: {
          name: document.getElementById("leadName").value || null,
          email: document.getElementById("leadEmail").value || null,
        },
      }),
    });
    const response = await responsePromise;
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(errorText || "Eligibility check failed");
    }
    const result = await response.json();
    await progressPromise;
    const envelopeResult = computeDetachedEnvelope(result);
    renderResult(result, envelopeResult);
  } catch (error) {
    console.error("Eligibility check failed", error);
    await progressPromise;
    renderResult({
      status: "needs_survey_zoning_review",
      headline: "Could not run check",
      blockers: [],
      redesign_items: [],
      review_items: [`API request failed: ${error.message}`],
      passed_checks: [],
      recommendations: [],
      permit_checklist: [],
      limitations: [],
      computed_options: {},
    });
  } finally {
    button.disabled = false;
    button.textContent = "Check Eligibility";
  }
}

document.getElementById("backButton").addEventListener("click", () => showStep(currentStep - 1));
document.getElementById("nextButton").addEventListener("click", () => {
  if (validateCurrentStep()) showStep(currentStep + 1);
});
document.getElementById("checkEligibilityButton").addEventListener("click", submitEligibility);
document.getElementById("resetButton").addEventListener("click", resetApplication);
document.getElementById("emailFindingsButton").addEventListener("click", emailFindings);
document.querySelectorAll("input").forEach((input) => input.addEventListener("change", () => {
  document.getElementById("validationBubble").classList.add("hidden");
  updateBranchFields();
  updateFollowups();
}));
function showInfoTooltip(info) {
  const tooltip = document.getElementById("infoTooltip");
  const panel = document.querySelector(".wizard-panel");
  const tip = info.getAttribute("data-tip");
  if (!tip) return;

  tooltip.textContent = tip;
  tooltip.classList.remove("hidden");

  const infoRect = info.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  const tooltipRect = tooltip.getBoundingClientRect();
  const left = Math.min(
    Math.max(infoRect.left - panelRect.left - tooltipRect.width + infoRect.width + 8, 18),
    panelRect.width - tooltipRect.width - 18
  );
  const top = Math.min(
    Math.max(infoRect.bottom - panelRect.top + 8, 18),
    panelRect.height - tooltipRect.height - 18
  );

  tooltip.style.left = `${left}px`;
  tooltip.style.top = `${top}px`;
}

function hideInfoTooltip() {
  const tooltip = document.getElementById("infoTooltip");
  if (tooltip) tooltip.classList.add("hidden");
}

document.addEventListener("mouseover", (event) => {
  const info = event.target.closest?.(".info");
  if (info) showInfoTooltip(info);
});
document.addEventListener("focusin", (event) => {
  const info = event.target.closest?.(".info");
  if (info) showInfoTooltip(info);
});
document.addEventListener("mouseout", (event) => {
  if (event.target.closest?.(".info")) hideInfoTooltip();
});
document.addEventListener("click", (event) => {
  const info = event.target.closest?.(".info");
  if (info) {
    event.preventDefault();
    showInfoTooltip(info);
  } else if (!event.target.closest?.("#infoTooltip")) {
    hideInfoTooltip();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    hideInfoTooltip();
  }
});
showStep(0);

require([
  "esri/Map",
  "esri/views/MapView",
  "esri/widgets/Search",
  "esri/rest/query",
  "esri/rest/locator",
  "esri/Graphic",
  "esri/geometry/Point",
  "esri/geometry/geometryEngine",
  "esri/geometry/support/webMercatorUtils",
], function (Map, MapView, Search, query, locator, Graphic, Point, geometryEngine, webMercatorUtils) {
  arcgis.Graphic = Graphic;
  arcgis.Point = Point;
  arcgis.geometryEngine = geometryEngine;
  arcgis.webMercatorUtils = webMercatorUtils;

  const map = new Map({ basemap: "streets-navigation-vector" });
  const view = new MapView({
    container: "viewDiv",
    map,
    center: [-77.093, 38.88],
    zoom: 12,
  });
  arcgis.view = view;

  const searchWidget = new Search({ view, includeDefaultSources: true, popupEnabled: true });
  view.ui.add(searchWidget, { position: "top-right" });
  document.getElementById("addressSearchHost").appendChild(searchWidget.container);
  searchWidget.when(() => {
    const input = document.querySelector("#addressSearchHost input");
    if (input) input.placeholder = "689 N Fillmore St, Arlington, VA";
  });
  let addressLoadTimer = null;
  function scheduleAddressLoad(address) {
    if (!address || address === lastLoadedAddress) return;
    window.clearTimeout(addressLoadTimer);
    addressLoadTimer = window.setTimeout(async () => {
      lastLoadedAddress = address;
      try {
        const candidate = await geocodeAddress(address);
        const resolvedAddress = candidate?.address || address;
        if (!isArlingtonAddressText(address) && !isArlingtonAddressText(resolvedAddress)) {
          lastLoadedAddress = "";
          lastRejectedAddress = address;
          closeAddressSuggestions();
          showArlingtonOnlyMessage();
          return;
        }
        if (candidate?.location) {
          await loadAddressLocation(candidate.location);
        } else {
          setStatus("Address could not be located.");
        }
      } catch (error) {
        console.error("Address load failed", error);
        setStatus(`Address load failed: ${error.message}`);
      }
    }, 450);
  }
  window.setInterval(() => {
    const input = document.querySelector("#addressSearchHost input");
    const value = input?.value?.trim() || "";
    if (value.endsWith(", USA") && isArlingtonAddressText(value)) {
      scheduleAddressLoad(value);
    } else if (value.endsWith(", USA") && value !== lastRejectedAddress) {
      lastRejectedAddress = value;
      closeAddressSuggestions();
      showArlingtonOnlyMessage();
    }
  }, 500);
  searchWidget.watch("searchTerm", (value) => {
    const address = value?.trim() || "";
    if (address.endsWith(", USA") && isArlingtonAddressText(address)) {
      scheduleAddressLoad(address);
    } else if (address.endsWith(", USA") && address !== lastRejectedAddress) {
      lastRejectedAddress = address;
      closeAddressSuggestions();
      showArlingtonOnlyMessage();
    }
  });
  function handleSuggestionPick(event) {
    const path = event.composedPath?.() || [];
    const item = path.find((node) => node?.classList?.contains("esri-menu__list-item"));
    if (!item) return;

    event.preventDefault();
    event.stopPropagation();

    const address = item.textContent.replace(/\s+/g, " ").trim();
    const input = document.querySelector("#addressSearchHost input");
    if (input) input.value = address;
    searchWidget.searchTerm = address;
    closeAddressSuggestions();
    scheduleAddressLoad(address);
  }
  const addressHost = document.getElementById("addressSearchHost");
  ["pointerdown", "mousedown", "click"].forEach((eventName) => {
    addressHost.addEventListener(eventName, handleSuggestionPick, true);
    document.addEventListener(eventName, handleSuggestionPick, true);
  });

  const zoningLayerUrl = "https://arlgis.arlingtonva.us/arcgis/rest/services/Public_Maps/Zoning_Map/MapServer/0";
  const propertyLayerUrl = "https://arlgis.arlingtonva.us/arcgis/rest/services/Open_Data/od_REA_Property_Polygons/FeatureServer/0";
  const buildingheightLayerUrl = "https://arlgis.arlingtonva.us/arcgis/rest/services/Open_Data/od_Building_Height_Polygons/FeatureServer/0";
  const drivewayLayerUrl = "https://arlgis.arlingtonva.us/arcgis/rest/services/Open_Data/od_Driveway_Polygons/FeatureServer/0";
  const buildingareaLayerUrl = "https://arlgis.arlingtonva.us/arcgis/rest/services/Open_Data/od_Building_Polygons/FeatureServer/0";

  function queryZoning(location) {
    return query.executeQueryJSON(zoningLayerUrl, {
      geometry: location,
      spatialRelationship: "intersects",
      outFields: ["REA_ZONECODE", "ZN_DESIG"],
      returnGeometry: false,
    }).then((result) => {
      const zoning = result.features[0]?.attributes;
      const numericCode = zoning?.REA_ZONECODE || null;
      const district = zoning?.ZN_DESIG || null;
      parcelState.zoning_code = district || numericCode;
      parcelState.zoning_description = numericCode ? `County code ${numericCode}` : null;
      setText("zoningCode", parcelState.zoning_code);
      const zoningDescription = document.getElementById("zoningDescription");
      if (zoningDescription) zoningDescription.textContent = `Description: ${parcelState.zoning_description || "N/A"}`;
    });
  }

  function queryParcel(location) {
    const searchGeometry = location.type === "point"
      ? geometryEngine.geodesicBuffer(location, 90, "feet")
      : location;
    return query.executeQueryJSON(propertyLayerUrl, {
      geometry: searchGeometry,
      spatialRelationship: "intersects",
      outFields: ["Shape__Area", "RPCMSTR"],
      returnGeometry: true,
      outSpatialReference: view.spatialReference,
    }).then((result) => {
      const feature = chooseParcelFeature(result.features, location, searchGeometry);
      if (!feature) return;
      parcelState.lot_area_sqft = Math.round(feature.attributes.Shape__Area || geometryAreaSqft(feature.geometry));
      parcelState.parcel_id = feature.attributes.RPCMSTR;
      geometryState.parcel = feature.geometry;
      setText("lotArea", `${parcelState.lot_area_sqft.toLocaleString()} sq ft`);
      setText("parcelID", parcelState.parcel_id);
      drawBaseGraphics();
      return Promise.all([queryDriveways(feature.geometry), queryBuildings(feature.geometry)]);
    });
  }

  function chooseParcelFeature(features, addressLocation, searchGeometry) {
    if (!features.length) return null;
    const containing = features.find((feature) => geometryEngine.contains(feature.geometry, addressLocation));
    if (containing) return containing;

    return features
      .map((feature) => {
        const overlap = geometryEngine.intersect(feature.geometry, searchGeometry);
        return { feature, overlapArea: geometryAreaSqft(overlap) };
      })
        .sort((a, b) => b.overlapArea - a.overlapArea)[0]?.feature || null;
    }

  function closeAddressSuggestions() {
    const input = document.querySelector("#addressSearchHost input");
    const container = document.querySelector("#addressSearchHost .esri-search__container");
    const menu = document.querySelector("#addressSearchHost .esri-search__suggestions-menu");
    if (input) input.setAttribute("aria-expanded", "false");
    if (container) container.classList.remove("esri-search--show-suggestions");
    if (menu) {
      menu.style.display = "none";
      menu.innerHTML = "";
    }
  }

  function queryHeight(location) {
    return query.executeQueryJSON(buildingheightLayerUrl, {
      geometry: location,
      spatialRelationship: "intersects",
      outFields: ["Est_Building_Height_ft"],
      returnGeometry: false,
    }).then((result) => {
      parcelState.estimated_building_height_ft = result.features[0]?.attributes?.Est_Building_Height_ft || null;
    });
  }

  function queryDriveways(parcelGeometry) {
    return query.executeQueryJSON(drivewayLayerUrl, {
      geometry: parcelGeometry,
      spatialRelationship: "intersects",
      outFields: ["*"],
      returnGeometry: true,
      outSpatialReference: view.spatialReference,
    }).then((result) => {
      geometryState.driveways = result.features
        .map((feature) => feature.geometry)
        .filter((geometry) => featureBelongsToParcel(geometry, parcelGeometry));
      parcelState.driveway_area_sqft = Math.round(geometryState.driveways.reduce((sum, geometry) => sum + geometryAreaSqft(geometry), 0));
      drawBaseGraphics();
    });
  }

  function queryBuildings(parcelGeometry) {
    return query.executeQueryJSON(buildingareaLayerUrl, {
      geometry: parcelGeometry,
      spatialRelationship: "intersects",
      outFields: ["*"],
      returnGeometry: true,
      outSpatialReference: view.spatialReference,
    }).then((result) => {
      geometryState.buildings = result.features
        .map((feature) => feature.geometry)
        .filter((geometry) => featureBelongsToParcel(geometry, parcelGeometry));
      const areas = geometryState.buildings.map((geometry) => geometryAreaSqft(geometry)).sort((a, b) => b - a);
      parcelState.main_building_footprint_sqft = Math.round(areas[0] || 0);
      parcelState.accessory_building_footprint_sqft = Math.round(areas.slice(1).reduce((sum, area) => sum + area, 0));
      parcelState.estimated_existing_coverage_sqft = Math.round(
        (parcelState.main_building_footprint_sqft || 0) +
        (parcelState.accessory_building_footprint_sqft || 0) +
        (parcelState.driveway_area_sqft || 0)
      );
      const coverage = parcelState.lot_area_sqft ? parcelState.estimated_existing_coverage_sqft / parcelState.lot_area_sqft : null;
      setText("coverageEstimate", coverage == null ? null : `${Math.round(coverage * 100)}% est.`);
      updateOptionSummary();
      drawBaseGraphics();
    });
  }

  function featureBelongsToParcel(featureGeometry, parcelGeometry) {
    const featureArea = geometryAreaSqft(featureGeometry);
    if (!featureArea) return false;

    const centroidInside = geometryEngine.contains(parcelGeometry, featureGeometry.centroid);
    const overlap = geometryEngine.intersect(featureGeometry, parcelGeometry);
    const overlapArea = geometryAreaSqft(overlap);
    const overlapRatio = overlapArea / featureArea;

    return overlapRatio >= 0.85 || (centroidInside && overlapRatio >= 0.5);
  }

  searchWidget.on("search-start", resetForNewAddress);
  async function geocodeAddress(address) {
    const candidates = await locator.addressToLocations("https://geocode.arcgis.com/arcgis/rest/services/World/GeocodeServer", {
      address: { SingleLine: address },
      outFields: ["*"],
      maxLocations: 1,
    });
    return candidates?.[0] || null;
  }

  async function loadAddressLocation(location) {
    resetForNewAddress();
    setStatus("Loading Arlington parcel and zoning data...");
    await view.goTo({ center: location, zoom: 18 }).catch(() => {});
    await Promise.all([queryZoning(location), queryParcel(location), queryHeight(location)]);
    if (geometryState.parcel) {
      await view.goTo(geometryState.parcel.extent.expand(1.8)).catch(() => {});
    }
    updateOptionSummary();
    document.getElementById("addressLoadStatus").textContent = parcelState.parcel_id
      ? `Loaded parcel ${parcelState.parcel_id}`
      : "Address found, but parcel data did not load.";
    setStatus(parcelState.parcel_id ? "Parcel loaded. Continue through the wizard." : "Address found, but parcel data did not load.");
  }

  searchWidget.on("select-result", async (event) => {
    const inputAddress = document.querySelector("#addressSearchHost input")?.value?.trim() || "";
    const selectedAddress = event.result?.name || event.result?.feature?.attributes?.Match_addr || inputAddress;
    if (!isArlingtonAddressText(selectedAddress) && !isArlingtonAddressText(inputAddress)) {
      closeAddressSuggestions();
      showArlingtonOnlyMessage();
      return;
    }
    lastLoadedAddress = inputAddress || selectedAddress;
    await loadAddressLocation(event.result.feature.geometry);
  });
});
