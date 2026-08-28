"use client";

import { Users } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type Team = { id: string; name: string };

type TeamFilterProps = {
  teams: Team[];
  selectedTeamId: string | null;
  onSelect: (teamId: string | null) => void;
};

const ALL_TEAMS_VALUE = "__all__";
const MAX_TEAMS_DISPLAY = 50;

export function TeamFilter({ teams, selectedTeamId, onSelect }: TeamFilterProps) {
  const displayTeams = teams.slice(0, MAX_TEAMS_DISPLAY);
  const selectedTeam = teams.find((t) => t.id === selectedTeamId);
  const label = selectedTeam ? selectedTeam.name : "전체 팀";

  function handleValueChange(value: string) {
    onSelect(value === ALL_TEAMS_VALUE ? null : value);
  }

  if (teams.length === 0) {
    return (
      <Select disabled>
        <SelectTrigger size="sm" className="rounded-lg border-slate-200 bg-white px-3">
          <SelectValue>
            <Users className="size-3.5" />
            <span className="truncate">전체 팀</span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectGroup>
            <div className="px-3 py-4 text-center text-sm text-muted-foreground">
              팀 없음: 설정에서 팀을 추가하세요
            </div>
          </SelectGroup>
        </SelectContent>
      </Select>
    );
  }

  return (
    <Select
      value={selectedTeamId ?? ALL_TEAMS_VALUE}
      onValueChange={handleValueChange}
    >
      <SelectTrigger size="sm" className="rounded-lg border-slate-200 bg-white px-3">
        <SelectValue>
          {!selectedTeamId && <Users className="size-3.5" />}
          <span className="truncate">{label}</span>
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectItem value={ALL_TEAMS_VALUE}>전체 팀</SelectItem>
          {displayTeams.map((team) => (
            <SelectItem key={team.id} value={team.id}>
              {team.name}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}
