import { useReducer, useState } from "react";
import { CalendarDialog } from "./CalendarDialog";
import events from "./events.json";
import { calendarState, monthDays } from "./model";
import { MathText } from "../../components/MathText";

export type CalendarEvent = (typeof events)[number];

export function Calendar({ initialDate }: { initialDate: string }) {
  const [state, dispatch] = useReducer(calendarState, { month: initialDate.slice(0, 6), date: initialDate });
  const [detail, setDetail] = useState<{ item: CalendarEvent; opener: HTMLElement } | null>(null);
  const selectedEvents = events.filter(event => event.date === state.date);
  return <section aria-labelledby="calendar-month" className="space-y-4 text-left">
    <h2 id="calendar-month" className="text-xl font-semibold text-ink">{state.month.slice(0, 4)} 年 {Number(state.month.slice(4))} 月</h2>
    <div className="flex flex-wrap gap-2">
      <button type="button" className="min-h-11 rounded-control border border-line px-4 text-sm hover:bg-bg-sunk" onClick={() => dispatch({ type: "move", offset: -1 })}>上一月</button>
      <button type="button" className="min-h-11 rounded-control border border-line px-4 text-sm hover:bg-bg-sunk" onClick={() => dispatch({ type: "today" })}>今天</button>
      <button type="button" className="min-h-11 rounded-control border border-line px-4 text-sm hover:bg-bg-sunk" onClick={() => dispatch({ type: "move", offset: 1 })}>下一月</button>
    </div>
    <div className="overflow-hidden rounded-card border border-line">
      <div className="grid grid-cols-7 border-b border-line bg-bg-sunk text-xs text-ink-3">{["一", "二", "三", "四", "五", "六", "日"].map(day => <div key={day} className="min-w-0 p-2">{day}</div>)}</div>
      <div className="grid grid-cols-7 gap-px bg-line">{monthDays(state.month).map((date, cell) => {
        if (!date) return <div key={`blank-${cell}`} aria-hidden="true" className="min-h-24 min-w-0 bg-bg-sunk sm:min-h-28" />;
        const dayEvents = events.filter(event => event.date === date);
        return <button key={date} type="button" aria-label={`${date.slice(0, 4)}年${Number(date.slice(4, 6))}月${Number(date.slice(6))}日`} aria-describedby={dayEvents.length ? `day-events-${date}` : undefined} aria-pressed={state.date === date} onClick={() => dispatch({ type: "select", date })} className={`relative flex min-h-24 min-w-0 flex-col gap-1 overflow-hidden p-1.5 text-left text-sm focus-visible:z-10 focus-visible:outline-2 focus-visible:outline-accent sm:min-h-28 sm:p-2 ${state.date === date ? "bg-accent/10 text-accent" : "bg-surface text-ink hover:bg-bg-sunk"}`}>
          <span className="num block shrink-0 leading-5">{Number(date.slice(6))}</span>
          <span id={`day-events-${date}`} className="block w-full min-w-0 space-y-1">
          {dayEvents.slice(0, 2).map(event => <span key={event.id} data-calendar-title="" title={event.title} className="block w-full min-w-0 line-clamp-2 text-[10px] leading-4 text-ink-2 [overflow-wrap:anywhere] sm:line-clamp-none sm:truncate sm:text-xs">{event.title}</span>)}
          {dayEvents.length > 2 && <span className="text-[10px] leading-4 text-ink-3 sm:text-xs" aria-label={`另有 ${dayEvents.length - 2} 条天象`}>+{dayEvents.length - 2}</span>}
          </span>
        </button>;
      })}</div>
    </div>
    <section aria-label="所选日期的天象" className="space-y-3">
      {selectedEvents.map(event => <button key={event.id} type="button" data-calendar-event="" aria-haspopup="dialog" onClick={click => setDetail({ item: event, opener: click.currentTarget })} className="card block w-full space-y-2 p-4 text-left hover:bg-bg-sunk focus-visible:outline-2 focus-visible:outline-accent [overflow-wrap:anywhere]">
        <span className="block font-semibold text-ink"><MathText text={event.title} /></span>
        <span className="block text-xs text-ink-4">{event.date.slice(0, 4)}-{event.date.slice(4, 6)}-{event.date.slice(6)} · 来源：合成示例数据</span>
      </button>)}
    </section>
    {detail && <CalendarDialog item={detail.item} returnFocusTo={detail.opener} onClose={() => setDetail(null)} />}
  </section>;
}
