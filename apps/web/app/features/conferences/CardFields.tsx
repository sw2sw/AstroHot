import type { ConferenceDeadlineView, ConferenceSummary } from "@aihot/contracts/site";
import { deadlineLabel, placeLabel, rangeLabel } from "./format";
import { conferenceAccess } from "./access";

const deadlineTone = { open: "text-ok-ink", today: "text-amber-ink", closed: "text-ink-3" } as const;

function Deadline({ deadline, registration = false }: { deadline: ConferenceDeadlineView; registration?: boolean }) {
  const label = deadlineLabel(deadline);
  return <span className={`font-medium ${deadlineTone[deadline.state]}`}>
    {registration ? label.replace(/^报名截止 /, "") : label}{deadline.state === "open" && "（未到截止）"}
  </span>;
}

/** Keep the full field list on the hub, not in the news-feed preview. */
export function CardFields({ item }: { item: ConferenceSummary }) {
  const registration = item.deadlines.find((d) => d.kind === "registration");
  const submission = item.deadlines.filter((d) => d.kind === "abstract" || d.kind === "paper");
  const access = conferenceAccess(item);

  const rows = [
    ["会期", rangeLabel(item)],
    ["地点", placeLabel(item) ?? item.venue],
    ["报名截止", registration ? <Deadline deadline={registration} registration /> : null],
    ["投稿截止", submission.length ? <span className="grid gap-0.5">{submission.map((d) => <Deadline key={d.kind} deadline={d} />)}</span> : access.submissionCutoff],
    ["官网", access.officialUrl ? "查看官网" : null],
    ["报名方式", access.registrationInfo ?? (access.registrationUrl ? "查看报名入口" : null)],
    ["会务费", item.meetingFee ?? "不详"],
    ["投稿方式", access.submissionUrl ? "在线投稿" : null],
  ] as const;

  return (
    <span className="mt-1.5 grid w-full min-w-0 gap-1 text-[12.5px] leading-[1.5]">
      {rows.map(([label, value]) => (
        <span key={label} className="grid grid-cols-[4em_minmax(0,1fr)] gap-2">
          <span className="text-ink-3">{label}</span>
          <span className={value ? "break-words text-ink-2" : "text-ink-4"}>{value ?? "未确认"}</span>
        </span>
      ))}
    </span>
  );
}
