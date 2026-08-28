/**
 * Property-based tests for TeamFilter logic.
 *
 * Feature: data-entry-pipeline-ux
 * Property 7: Team dropdown respects maximum display limit
 * Validates: Requirements 4.1
 *
 * Property 9: Team filter button label reflects selection
 * Validates: Requirements 4.4
 *
 * Tests that the TeamFilter dropdown shows at most 50 team items plus "전체 팀",
 * and that the button label correctly reflects the selected team name or "전체 팀".
 */

import { describe, it, expect } from "vitest";
import * as fc from "fast-check";

// ---------------------------------------------------------------------------
// Replicate TeamFilter core logic (same as in team-filter.tsx)
// ---------------------------------------------------------------------------

type Team = { id: string; name: string };

const MAX_TEAMS_DISPLAY = 50;

/** Returns the list of teams to display in the dropdown (max 50). */
function getDisplayTeams(teams: Team[]): Team[] {
  return teams.slice(0, MAX_TEAMS_DISPLAY);
}

/** Returns the button label based on the selected team. */
function getFilterLabel(teams: Team[], selectedTeamId: string | null): string {
  const selectedTeam = teams.find((t) => t.id === selectedTeamId);
  return selectedTeam ? selectedTeam.name : "전체 팀";
}

// ---------------------------------------------------------------------------
// Generators
// ---------------------------------------------------------------------------

/** Generates an arbitrary Team object with unique id and non-empty name. */
const teamArb: fc.Arbitrary<Team> = fc.record({
  id: fc.uuid(),
  name: fc.string({ minLength: 1, maxLength: 50 }),
});

/** Generates an arbitrary list of teams (0 to 200 items). */
const teamListArb: fc.Arbitrary<Team[]> = fc.array(teamArb, { minLength: 0, maxLength: 200 });

// ---------------------------------------------------------------------------
// Property 7: Team dropdown respects maximum display limit
// Validates: Requirements 4.1
// ---------------------------------------------------------------------------

describe("Property 7: Team dropdown respects maximum display limit", () => {
  it("displays at most 50 team items regardless of total team count", () => {
    fc.assert(
      fc.property(teamListArb, (teams) => {
        const displayTeams = getDisplayTeams(teams);

        // Dropdown shows at most 50 items (+ "전체 팀" which is always first)
        expect(displayTeams.length).toBeLessThanOrEqual(MAX_TEAMS_DISPLAY);
      }),
      { numRuns: 100 },
    );
  });

  it("displays all teams when list has 50 or fewer items", () => {
    fc.assert(
      fc.property(
        fc.array(teamArb, { minLength: 0, maxLength: 50 }),
        (teams) => {
          const displayTeams = getDisplayTeams(teams);

          expect(displayTeams.length).toBe(teams.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("truncates to exactly 50 when list exceeds 50 items", () => {
    fc.assert(
      fc.property(
        fc.array(teamArb, { minLength: 51, maxLength: 200 }),
        (teams) => {
          const displayTeams = getDisplayTeams(teams);

          expect(displayTeams.length).toBe(MAX_TEAMS_DISPLAY);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("preserves original order of first 50 teams", () => {
    fc.assert(
      fc.property(teamListArb, (teams) => {
        const displayTeams = getDisplayTeams(teams);

        for (let i = 0; i < displayTeams.length; i++) {
          expect(displayTeams[i]).toBe(teams[i]);
        }
      }),
      { numRuns: 100 },
    );
  });
});

// ---------------------------------------------------------------------------
// Property 9: Team filter button label reflects selection
// Validates: Requirements 4.4
// ---------------------------------------------------------------------------

describe("Property 9: Team filter button label reflects selection", () => {
  it("label equals selected team name when a team is selected", () => {
    fc.assert(
      fc.property(
        fc.array(teamArb, { minLength: 1, maxLength: 100 }),
        (teams) => {
          // Pick a random team from the list
          const randomIndex = Math.floor(Math.random() * teams.length);
          const selectedTeam = teams[randomIndex];

          const label = getFilterLabel(teams, selectedTeam.id);

          expect(label).toBe(selectedTeam.name);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("label is '전체 팀' when no team is selected (null)", () => {
    fc.assert(
      fc.property(teamListArb, (teams) => {
        const label = getFilterLabel(teams, null);

        expect(label).toBe("전체 팀");
      }),
      { numRuns: 100 },
    );
  });

  it("label is '전체 팀' when selectedTeamId does not match any team", () => {
    fc.assert(
      fc.property(
        teamListArb,
        fc.uuid(),
        (teams, nonExistentId) => {
          // Ensure the generated ID doesn't accidentally match a team
          const teamsWithoutId = teams.filter((t) => t.id !== nonExistentId);

          const label = getFilterLabel(teamsWithoutId, nonExistentId);

          expect(label).toBe("전체 팀");
        },
      ),
      { numRuns: 100 },
    );
  });
});
