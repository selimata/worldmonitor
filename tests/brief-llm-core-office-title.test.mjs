/**
 * Gate contract for OFFICE TITLES vs INVENTED NAMES.
 *
 * Aug 31 incident: the AI World Brief stopped publishing for ~4.5h
 * (news:insights:v1 unwritten 03:41 -> 08:01, every seed-insights tick ending
 * "=== Done (no write) ==="). CNBC re-worded one headline in place, from
 * "Indian PM Modi implores..." to "Indian Prime Minister Modi asks...", and
 * every synthesis attempt was then rejected LEAD_PROPER_NOUN with detail
 * "india pm": the lead said "India's PM", the source said "Prime Minister",
 * and validateNoHallucinatedProperNouns matches proper-noun sequences
 * CONTIGUOUSLY with no PM <-> Prime Minister equivalence. A lead rejection is
 * fatal to the whole brief (per-story LINES degrade to their headline; the
 * lead does not), so one abbreviation blocked every run.
 *
 * The gate exists because of the May 19, 2026 incident, where the model
 * shipped "Lebanese President Michel Aoun pledged..." against a headline that
 * named nobody (the real Lebanese president is Joseph Aoun). Loosening the
 * gate must not re-open that. The distinction this file pins:
 *
 *   an OFFICE TITLE is not an identity  -> PM == Prime Minister is safe
 *   a PERSON'S NAME is an identity      -> "Michel Aoun" must stay rejected
 *
 * The MUST-ACCEPT block is the acceptance criterion for the gate fix and is
 * RED until it lands. Every MUST-REJECT assertion is green both before and
 * after, and is the reason the fix is safe.
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

describe('brief grounding gate — office titles vs invented names', () => {
  let validateNoHallucinatedProperNouns;
  let composeSynthesizedBriefResult;
  before(async () => {
    ({ validateNoHallucinatedProperNouns } = await import('../shared/brief-llm-core.js'));
    ({ composeSynthesizedBriefResult } = await import('../scripts/_insights-brief.mjs'));
  });

  // ── The Aug 31 corpus, both CNBC phrasings of the SAME url ──────────────
  const CNBC_EXPANDED = 'Indian Prime Minister Modi asks Putin to end Ukraine war';
  const CNBC_ABBREV = 'Indian PM Modi implores Putin to end Ukraine war';

  // ── The May 19 corpus: a headline that names NOBODY ─────────────────────
  const MAY_19_HEADLINE =
    "Lebanese president vows to 'do the impossible' to end war with Israel as strikes continue despite ceasefire";
  const MAY_19_CAPTURED =
    'Lebanese President Michel Aoun pledged to pursue all avenues to end the ongoing conflict '
    + 'with Israel, even as Israeli strikes continued despite a declared ceasefire.';

  describe('MUST-ACCEPT: the title abbreviation is the same office', () => {
    it('REGRESSION (Aug 31): "India\'s PM" grounds against "Indian Prime Minister"', () => {
      const r = validateNoHallucinatedProperNouns(
        "India's PM asked Putin to end the Ukraine war [3].", CNBC_EXPANDED);
      assert.equal(r.ok, true,
        `the outage: rejected as ${JSON.stringify(r.hallucinated)} — PM and Prime Minister are one office`);
    });

    it('"Indian PM" grounds against "Indian Prime Minister"', () => {
      assert.equal(validateNoHallucinatedProperNouns(
        'Indian PM asked Putin to end the Ukraine war [3].', CNBC_EXPANDED).ok, true);
    });

    it('"PM Modi" grounds against "Indian Prime Minister Modi"', () => {
      assert.equal(validateNoHallucinatedProperNouns(
        'PM Modi asked Putin to end the Ukraine war [3].', CNBC_EXPANDED).ok, true);
    });

    it('equivalence is BIDIRECTIONAL — expanded lead, abbreviated source', () => {
      assert.equal(validateNoHallucinatedProperNouns(
        "India's Prime Minister asked Putin to end the war [3].", CNBC_ABBREV).ok, true,
      'CNBC edits headlines in place; the gate must not depend on which way it was worded');
    });

    it('the pre-existing exact-match path is unchanged', () => {
      assert.equal(validateNoHallucinatedProperNouns(
        'Indian Prime Minister Modi asked Putin to end the war [3].', CNBC_EXPANDED).ok, true);
    });
  });

  describe('MUST-REJECT: May 19 — a title never licenses a NAME', () => {
    it('REGRESSION (May 19, captured): "Michel Aoun" against a nameless headline', () => {
      const r = validateNoHallucinatedProperNouns(MAY_19_CAPTURED, MAY_19_HEADLINE);
      assert.equal(r.ok, false, 'the incident the gate exists for must stay caught');
      assert.ok(r.hallucinated.includes('michel') || r.hallucinated.includes('aoun'),
        `expected the NAME to be the flagged token; got ${JSON.stringify(r.hallucinated)}`);
    });

    it('May 19 class: "President Michel Aoun reportedly stated..."', () => {
      assert.equal(validateNoHallucinatedProperNouns(
        'President Michel Aoun reportedly stated he would pursue all paths to end the war.',
        MAY_19_HEADLINE).ok, false);
    });

    it('May 19 class: "Lebanese leader Aoun..."', () => {
      assert.equal(validateNoHallucinatedProperNouns(
        'Lebanese leader Aoun, who reportedly pledged action, faces ongoing strikes.',
        MAY_19_HEADLINE).ok, false);
    });

    it('May 19 class: "Aoun, the Lebanese president, said..."', () => {
      assert.equal(validateNoHallucinatedProperNouns(
        'Aoun, the Lebanese president, said the war with Israel must end.',
        MAY_19_HEADLINE).ok, false);
    });

    it('the May 19 shape wearing the NEW title: "PM Sharif" against a nameless headline', () => {
      assert.equal(validateNoHallucinatedProperNouns(
        'PM Sharif vowed to end the war [1].',
        'Pakistani prime minister vows to end the war').ok, false,
      'accepting PM must not become a channel for inventing whoever holds the office');
    });
  });

  describe('MUST-REJECT: the title carries no other cargo', () => {
    it('a name attached to the title is still invented', () => {
      assert.equal(validateNoHallucinatedProperNouns(
        "India's PM Gandhi asked Putin to end the Ukraine war [3].", CNBC_EXPANDED).ok, false);
    });

    it('the title does not travel to another country', () => {
      assert.equal(validateNoHallucinatedProperNouns(
        "Pakistan's PM asked Putin to end the Ukraine war [3].", CNBC_EXPANDED).ok, false);
    });

    it('grounding "PM" licenses nothing else in the sentence', () => {
      assert.equal(validateNoHallucinatedProperNouns(
        'The PM met Emmanuel Macron in Paris [3].', CNBC_EXPANDED).ok, false);
    });

    it('swapping which office is named does not smuggle a name in', () => {
      assert.equal(validateNoHallucinatedProperNouns(
        'President Aoun pledged action [1].', 'Lebanese prime minister pledged action').ok, false);
    });
  });

  describe('MUST-ACCEPT: a source headline that opens with the bare office', () => {
    // 'PM' is in TITLE_PREFIX_STOP, so like 'Prime'/'Minister' it is consumed
    // at sequence START only. A wire headline that opens "Prime Minister Modi
    // ..." reduces to ['modi']; a lead writing "PM Modi" reduces to the same.
    it('"PM Modi" grounds against a bare "Prime Minister Modi" headline', () => {
      assert.equal(validateNoHallucinatedProperNouns(
        'PM Modi asked Putin to end the war [1].',
        'Prime Minister Modi asks Putin to end Ukraine war').ok, true);
    });

    it('"PM Netanyahu" grounds against a bare "Prime Minister Netanyahu" headline', () => {
      assert.equal(validateNoHallucinatedProperNouns(
        'PM Netanyahu approved the operation [1].',
        'Prime Minister Netanyahu approves the Rafah operation').ok, true);
    });

    it('but the bare office still cannot invent a COUNTRY', () => {
      assert.equal(validateNoHallucinatedProperNouns(
        "India's PM asked Putin to end the war [1].",
        'Prime Minister Modi asks Putin to end Ukraine war').ok, false,
      'the source never says India; mid-sequence PM is retained precisely so this fails');
    });
  });

  describe('MUST-REJECT: an invented OFFICE is the May 19 class too', () => {
    // These pin the rejected design. Consuming title words ANYWHERE in a
    // sequence (not just at its start) would close the bare-headline gap more
    // broadly, but it was measured to accept all three of these: both sides
    // lose the title and two DIFFERENT offices collapse onto one sequence.
    // An invented office riding a real name is the same failure as an invented
    // name riding a real office. Do not "simplify" TITLE_PREFIX_STOP handling
    // into an unconditional consume without re-running these.
    it('does not let a lead promote a prime minister to president', () => {
      assert.equal(validateNoHallucinatedProperNouns(
        'Indian President Modi asked Putin to stop [1].',
        'Indian Prime Minister Modi asks Putin to end Ukraine war').ok, false);
    });

    it('does not let a lead swap which ministry a named official runs', () => {
      assert.equal(validateNoHallucinatedProperNouns(
        'Israeli Defense Minister Katz ordered it [1].',
        'Israeli Foreign Minister Katz meets EU envoys').ok, false);
    });

    it('does not let a lead promote a named officer\'s rank', () => {
      assert.equal(validateNoHallucinatedProperNouns(
        'Israeli General Cohen led the raid [1].',
        'Israeli Colonel Cohen led the raid on the compound').ok, false);
    });
  });

  describe('END-TO-END: the brief publishes instead of being dropped', () => {
    const stories = [
      {
        primaryTitle: CNBC_EXPANDED, primarySource: 'CNBC', primaryLink: 'https://cnbc.com/a',
        sourceCount: 5, uniqueSourceCount: 4, isAlert: false, threatLevel: 'medium',
      },
      {
        primaryTitle: 'EU agrees new sanctions package targeting Russian oil exports',
        primarySource: 'Reuters', primaryLink: 'https://reuters.com/b',
        sourceCount: 6, uniqueSourceCount: 5, isAlert: false, threatLevel: 'medium',
      },
    ];

    it('REGRESSION (Aug 31): the Aug 31 lead survives composeSynthesizedBriefResult', () => {
      const raw = JSON.stringify({
        lead: "India's PM asked Putin to end the Ukraine war [1]. "
          + 'The EU agreed a new sanctions package targeting Russian oil exports [2].',
        lines: [
          { n: 1, text: 'Modi pressed Putin to end the war' },
          { n: 2, text: 'EU targets Russian oil exports' },
        ],
      });
      const r = composeSynthesizedBriefResult(raw, stories, { briefCluster: stories[0] });
      assert.equal(r.rejection, null,
        `whole brief dropped: ${r.rejection} (${r.rejectionDetail}) — this is the "Done (no write)" loop`);
      assert.ok(r.brief.lead.includes("India's PM"));
    });

    it('a lead sentence that invents a name is dropped, the rest still ships', () => {
      const raw = JSON.stringify({
        lead: 'Indian PM Modi asked Putin to end the Ukraine war [1]. '
          + "India's PM Gandhi pressed Putin on the same day [1]. "
          + 'The EU agreed a new sanctions package targeting Russian oil exports [2].',
        lines: [
          { n: 1, text: 'Modi pressed Putin to end the war' },
          { n: 2, text: 'EU targets Russian oil exports' },
        ],
      });
      const r = composeSynthesizedBriefResult(raw, stories, { briefCluster: stories[0] });
      assert.equal(r.rejection, null, 'the grounded sentences carry the brief');
      assert.equal(r.brief.droppedLeadSentences, 1);
      assert.doesNotMatch(r.brief.lead, /Gandhi/, 'the invented name must not ship');
      assert.match(r.brief.lead, /^Indian PM Modi .* The EU agreed .*\[2\]\.$/);
    });

    it('a survivor that no longer anchors to the corpus is still refused', () => {
      // Dropping a sentence must not be able to smuggle a brief past the
      // anchor floor: checkLeadGrounding judges what SHIPS, so a lead whose
      // remaining text falls below the anchor threshold is refused outright
      // rather than published thin.
      const raw = JSON.stringify({
        lead: "India's PM Gandhi asked Putin to end the Ukraine war [1]. "
          + 'The EU agreed a new sanctions package targeting Russian oil exports [2].',
        lines: [
          { n: 1, text: 'Modi pressed Putin to end the war' },
          { n: 2, text: 'EU targets Russian oil exports' },
        ],
      });
      const r = composeSynthesizedBriefResult(raw, stories, { briefCluster: stories[0] });
      assert.equal(r.rejection, 'lead-grounding');
      assert.equal(r.brief, null);
    });
  });
});
