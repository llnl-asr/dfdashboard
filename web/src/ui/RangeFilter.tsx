import { formatTime } from "../timeline/format";

// A compact two-thumb time-range slider over [0, span] (microseconds). Commits
// on release (onChange) so it doesn't re-query on every drag frame.
export function RangeFilter(props: {
  span: number;
  begin: number;
  end: number;
  onChange: (begin: number, end: number) => void;
}) {
  const end = () => (props.end > 0 ? props.end : props.span);
  const pm = (v: number) => (props.span > 0 ? Math.round((v / props.span) * 1000) : 0);
  const us = (p: number) => (Number(p) / 1000) * props.span;
  const bPm = () => pm(props.begin);
  const ePm = () => pm(end());

  return (
    <div class="rangefilter" title="dashboard time window">
      <div class="rangefilter-track" />
      <div
        class="rangefilter-fill"
        style={{ left: `${bPm() / 10}%`, width: `${(ePm() - bPm()) / 10}%` }}
      />
      <input
        type="range"
        min="0"
        max="1000"
        value={bPm()}
        onInput={(e) => props.onChange(us(Math.min(+e.currentTarget.value, ePm() - 1)), end())}
      />
      <input
        type="range"
        min="0"
        max="1000"
        value={ePm()}
        onInput={(e) =>
          props.onChange(props.begin, us(Math.max(+e.currentTarget.value, bPm() + 1)))
        }
      />
      <span class="rangefilter-label">
        {formatTime(props.begin)} - {formatTime(end())}
      </span>
    </div>
  );
}
