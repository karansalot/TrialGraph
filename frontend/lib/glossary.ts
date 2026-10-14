// Plain-language definitions used by <Term> tooltips and the Help panel.
export const GLOSSARY: Record<string, { term: string; text: string }> = {
  recruiting: { term: "Recruiting site", text: "A site counts only if ClinicalTrials.gov lists BOTH the study and that specific site as currently recruiting. Completed, paused or not-yet-open studies never count." },
  straight: { term: "Straight-line distance", text: "Distance 'as the crow flies' on the Earth's surface. Real driving distance and travel time are always longer." },
  threshold: { term: "Distance threshold", text: "The distance you consider reasonable to travel for a trial. People living within it are counted as 'covered'. Try 25, 50 or 100 miles to see how conclusions change." },
  gap: { term: "Access-gap county", text: "A county where fewer than a chosen share of residents (50% by default) live within the distance threshold of a recruiting site." },
  lens: { term: "Trial-type lens", text: "Looks only at a kind of trial across all cancers: early-phase (Phase 1), Phase 3, open to adults 75+, open to children, or with recruitment status verified in the last year." },
  rucc: { term: "Metro / non-metro (RUCC)", text: "USDA Rural-Urban Continuum Codes. Codes 1-3 are metro counties, 4-9 are non-metro, 9 being the most rural." },
  tract: { term: "Census tract", text: "A small neighbourhood-sized area of about 4,000 people. TrialGraph measures distance from each tract's population centre, so results reflect where people actually live." },
  moe: { term: "Margin of error", text: "Census survey figures are estimates. '± x' is the 90% margin of error: the true value is very likely within that range. Small counties have wide margins." },
  places: { term: "CDC PLACES", text: "Model-based estimates of health measures for every county from CDC survey data. Useful context, not counts of patients, and never treated as trial demand." },
  hypothetical: { term: "Hypothetical site", text: "A what-if location you place to test coverage. It is not a real or planned facility, and its score says nothing about whether opening a site there is feasible." },
  score: { term: "Opportunity score", text: "0-100 weighted average of five parts: people newly covered, miles saved, socioeconomic barriers, rurality and cancer prevalence. You set the weights." },
  sensitivity: { term: "Sensitivity analysis", text: "Re-runs the ranking with 500 random weightings and other distance thresholds to show which recommendations are robust and which are fragile." },
  geocode: { term: "Location confidence", text: "The registry only gives a city for each site. TrialGraph places sites at their ZIP area when the ZIP agrees with the city (high), at the city (medium), or flags conflicts (low)." },
};
