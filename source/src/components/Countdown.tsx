import { useEffect, useMemo, useState } from 'react'
import { CalendarDays, Clock, X } from 'lucide-react'
import { HOLIDAYS, IMPORTANT_DATES } from '@/data/siteData'

/* 每秒刷新一次「现在」 */
function useNow(interval = 1000) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), interval)
    return () => clearInterval(id)
  }, [interval])
  return now
}

const DAY_MS = 86400000
const HOUR_MS = 3600000
const MIN_MS = 60000
const pad2 = (n: number) => n.toString().padStart(2, '0')

/* 把两个时间差拆成 月/天/时/分/秒（月按日历，时/分/秒从「当前时刻」实时计算） */
function calendarFull(target: Date, from: Date) {
  let months = (target.getFullYear() - from.getFullYear()) * 12 + (target.getMonth() - from.getMonth())
  const atSame = (m: number) =>
    new Date(from.getFullYear(), from.getMonth() + m, from.getDate(), from.getHours(), from.getMinutes(), from.getSeconds())
  let d = atSame(months)
  if (d > target) {
    months -= 1
    d = atSame(months)
  }
  let rem = target.getTime() - d.getTime()
  const days = Math.floor(rem / DAY_MS)
  rem -= days * DAY_MS
  const hours = Math.floor(rem / HOUR_MS)
  rem -= hours * HOUR_MS
  const minutes = Math.floor(rem / MIN_MS)
  rem -= minutes * MIN_MS
  const seconds = Math.floor(rem / 1000)
  return { months, days, hours, minutes, seconds }
}

function fmtDateFull(d: Date) {
  const w = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()]
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} 周${w} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/* 重要日期面板：移动端默认折叠（天分秒），点击展开详细（月天分秒）；桌面端完整显示多个 */
function ImportantDatePanel({
  now,
  onOpenAll,
}: {
  now: Date
  onOpenAll: () => void
}) {
  const [expanded, setExpanded] = useState(false)
  const upcoming = useMemo(() => {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    return IMPORTANT_DATES.map((d) => ({ ...d, dateObj: new Date(d.date) }))
      .sort((a, b) => a.dateObj.getTime() - b.dateObj.getTime())
      .filter((d) => d.dateObj >= new Date(today.getTime() - 86400000))
      .slice(0, 4)
  }, [now])
  const first = upcoming[0]
  const firstDiff = first ? calendarFull(first.dateObj, now) : null
  // 折叠视图按「当前时刻剩余」折算成 天/时/分（月与天全部折算成天）
  const firstRemainSec = first ? Math.max(0, Math.floor((first.dateObj.getTime() - now.getTime()) / 1000)) : 0
  const foldDays = Math.floor(firstRemainSec / 86400)
  const foldHours = Math.floor((firstRemainSec % 86400) / 3600)
  const foldMins = Math.floor((firstRemainSec % 3600) / 60)

  const renderFull = (d: { name: string; dateObj: Date }) => {
    const f = calendarFull(d.dateObj, now)
    return (
      <div key={d.name} className="rounded-xl bg-white/15 px-3 py-2.5 backdrop-blur-sm">
        <div className="mb-1.5 text-xs font-medium opacity-85">{d.name}</div>
        <div className="flex items-center justify-between gap-1 text-sm font-extrabold tabular-nums md:text-base">
          <span>{f.months}月</span>
          <span>{f.days}天</span>
          <span>{pad2(f.hours)}时</span>
          <span>{pad2(f.minutes)}分</span>
          <span>{pad2(f.seconds)}秒</span>
        </div>
      </div>
    )
  }

  return (
    <div className="group flex flex-1 flex-col overflow-hidden rounded-2xl bg-gradient-to-br from-[#4a6cf7] to-[#3b5bfd] p-4 text-left text-white shadow-[0_8px_25px_rgba(59,91,253,0.18)] dark:from-[#1e3a8a] dark:to-[#1e293b] md:p-5">
      <div className="mb-2 flex items-center gap-2 md:mb-3">
        <CalendarDays className="h-5 w-5 text-white" />
        <h2 className="text-base font-bold text-white">重要日期倒计时</h2>
        <button
          type="button"
          onClick={onOpenAll}
          className="ml-auto rounded-full bg-white/15 px-2 py-0.5 text-[10px] font-medium opacity-90 transition-opacity hover:opacity-100"
        >
          查看全部
        </button>
      </div>

      {!first || !firstDiff ? (
        <p className="py-3 text-sm">本学期暂无重要日期</p>
      ) : (
        <>
          {/* 移动端：默认只显示最近的（天时分），点击查看全部弹窗 */}
          <div className="lg:hidden">
            {expanded ? (
              <div className="max-h-[160px] space-y-2 overflow-y-auto pr-1">
                {upcoming.map((d) => renderFull(d))}
                <button
                  type="button"
                  onClick={() => setExpanded(false)}
                  className="w-full rounded-full bg-white/15 py-2 text-xs font-semibold opacity-90 transition-opacity hover:opacity-100"
                >
                  收起
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setExpanded(true)}
                className="w-full rounded-xl bg-white/15 px-3 py-2.5 text-left backdrop-blur-sm transition-colors hover:bg-white/20"
              >
                <div className="text-xs font-medium opacity-85">{first.name}</div>
                <div className="mt-1 text-xl font-extrabold tabular-nums leading-none">
                  {foldDays}天 {foldHours}时 {foldMins}分
                </div>
              </button>
            )}
          </div>

          {/* 桌面端：完整显示月天分秒，显示多个 */}
          <div className="hidden lg:block">
            {upcoming.length === 0 ? (
              <p className="py-3 text-sm">暂无重要日期</p>
            ) : (
              <ul className="space-y-2">{upcoming.map((d) => renderFull(d))}</ul>
            )}
          </div>
        </>
      )}
    </div>
  )
}

/* 节假日面板（卡片式，点击查看全部） */
function HolidayPanel({
  now,
  onOpenAll,
}: {
  now: Date
  onOpenAll: () => void
}) {
  const upcoming = useMemo(() => {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    return HOLIDAYS.map((h) => ({ ...h, dateObj: new Date(h.date + 'T00:00:00') }))
      .sort((a, b) => a.dateObj.getTime() - b.dateObj.getTime())
      .filter((h) => h.dateObj >= today)
      .slice(0, 3)
  }, [now])

  return (
    <button
      type="button"
      onClick={onOpenAll}
      className="group flex flex-1 flex-col overflow-hidden rounded-2xl bg-white p-4 text-left shadow-[0_8px_25px_rgba(0,0,0,0.06)] dark:bg-[#1b2432] md:p-5"
    >
      <div className="mb-2 flex items-center gap-2 md:mb-3">
        <Clock className="h-5 w-5 text-[#07c160]" />
        <h2 className="text-base font-bold text-[#2c3e50] dark:text-slate-200">节假日倒计时</h2>
        <span className="ml-auto rounded-full bg-[#eef1ff] px-2 py-0.5 text-[10px] font-medium text-[#3b5bfd] group-hover:bg-[#dce3ff] dark:bg-[#2a3550] dark:text-[#9db1ff]">
          查看全部
        </span>
      </div>
      {upcoming.length === 0 ? (
        <p className="py-3 text-sm text-[#90a4ae] dark:text-slate-500">本学期暂无更多法定节假日 🎈</p>
      ) : (
        <ul className="flex flex-col gap-2 md:gap-2.5">
          {upcoming.map((h) => {
            const daysLeft = Math.ceil((h.dateObj.getTime() - now.getTime()) / DAY_MS)
            return (
              <li
                key={h.name}
                className="flex items-center gap-2 rounded-xl bg-[#f8fafc] px-2.5 py-2 dark:bg-[#202a3a] md:gap-3 md:px-3 md:py-2.5"
              >
                <div className="flex flex-col">
                  <span className="text-[13px] font-bold text-[#2c3e50] dark:text-slate-200 md:text-sm">{h.name}</span>
                  <span className="hidden text-[11px] text-[#9aa7b8] dark:text-slate-500 md:inline">
                    {h.date.slice(5)} 放假 {h.days} 天
                  </span>
                </div>
                <div className="ml-auto text-right">
                  <span className="text-base font-extrabold tabular-nums text-[#07c160] md:text-lg">{daysLeft}</span>
                  <span className="ml-0.5 text-xs font-medium text-[#07c160]">天</span>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </button>
  )
}

/* 弹窗：全部重要日期 */
function AllImportantDatesModal({
  open,
  onClose,
  now,
}: {
  open: boolean
  onClose: () => void
  now: Date
}) {
  if (!open) return null
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const list = IMPORTANT_DATES.map((d) => ({ ...d, dateObj: new Date(d.date) })).sort(
    (a, b) => a.dateObj.getTime() - b.dateObj.getTime(),
  )
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-5" onClick={onClose}>
      <div
        className="w-full max-w-md overflow-hidden rounded-3xl bg-white shadow-2xl dark:bg-[#1b2432]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between bg-gradient-to-r from-[#4a6cf7] to-[#3b5bfd] px-5 py-3">
          <h3 className="text-base font-bold text-white">全部重要日期（{list.length} 个）</h3>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-full bg-white/20 text-white transition-colors hover:bg-white/30"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <ul className="max-h-[65vh] divide-y divide-gray-100 overflow-y-auto dark:divide-[#2a3550]">
          {list.map((d) => {
            const diff = calendarFull(d.dateObj, now)
            const isPast = d.dateObj < today
            return (
              <li key={d.name} className="px-5 py-3.5">
                <div className="mb-1.5 flex items-center gap-2">
                  <span className="rounded-lg bg-[#eef1ff] px-2 py-1 text-xs font-semibold text-[#3b5bfd] dark:bg-[#2a3550] dark:text-[#9db1ff]">
                    {d.name}
                  </span>
                  {isPast && (
                    <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs font-bold text-gray-500 dark:bg-[#202a3a] dark:text-slate-400">
                      已过
                    </span>
                  )}
                </div>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-[#9aa7b8] dark:text-slate-500">{fmtDateFull(d.dateObj)}</span>
                  <span className="text-sm font-extrabold tabular-nums text-[#3b5bfd] dark:text-[#9db1ff]">
                    {isPast
                      ? '0月 0天 0时 0分 0秒'
                      : `${diff.months}月 ${diff.days}天 ${pad2(diff.hours)}时 ${pad2(diff.minutes)}分 ${pad2(diff.seconds)}秒`}
                  </span>
                </div>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}

/* 弹窗：全部节假日（含日期、放假天数、倒计时天数） */
function AllHolidaysModal({
  open,
  onClose,
  now,
}: {
  open: boolean
  onClose: () => void
  now: Date
}) {
  if (!open) return null
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const list = HOLIDAYS.map((h) => ({ ...h, dateObj: new Date(h.date + 'T00:00:00') })).sort(
    (a, b) => a.dateObj.getTime() - b.dateObj.getTime(),
  )
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-5" onClick={onClose}>
      <div
        className="w-full max-w-md overflow-hidden rounded-3xl bg-white shadow-2xl dark:bg-[#1b2432]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between bg-gradient-to-r from-[#07c160] to-[#05a050] px-5 py-3">
          <h3 className="text-base font-bold text-white">全部法定节假日（{list.length} 个）</h3>
          <button
            onClick={onClose}
            className="flex h-7 w-7 items-center justify-center rounded-full bg-white/20 text-white transition-colors hover:bg-white/30"
            aria-label="关闭"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <ul className="max-h-[65vh] divide-y divide-gray-100 overflow-y-auto dark:divide-[#2a3550]">
          {list.map((h) => {
            const daysLeft = Math.ceil((h.dateObj.getTime() - now.getTime()) / DAY_MS)
            const isPast = h.dateObj < today
            return (
              <li key={h.name} className="flex items-center gap-3 px-5 py-3.5">
                <div className="flex flex-1 flex-col">
                  <span className="text-sm font-bold text-[#2c3e50] dark:text-slate-200">{h.name}</span>
                  <span className="text-xs text-[#9aa7b8] dark:text-slate-500">
                    {h.date} · 放假 {h.days} 天
                  </span>
                </div>
                <div className="text-right">
                  <span
                    className={`text-base font-extrabold tabular-nums ${
                      isPast ? 'text-gray-400 dark:text-slate-500' : 'text-[#07c160]'
                    }`}
                  >
                    {isPast ? '0' : daysLeft}
                  </span>
                  <span
                    className={`ml-0.5 text-xs font-medium ${
                      isPast ? 'text-gray-400 dark:text-slate-500' : 'text-[#07c160]'
                    }`}
                  >
                    天
                  </span>
                </div>
              </li>
            )
          })}
        </ul>
      </div>
    </div>
  )
}

export default function CountdownSection() {
  const now = useNow(1000)
  const [openImp, setOpenImp] = useState(false)
  const [openHol, setOpenHol] = useState(false)
  return (
    <>
      <section className="mb-7 flex flex-row gap-3 md:gap-4">
        <ImportantDatePanel now={now} onOpenAll={() => setOpenImp(true)} />
        <HolidayPanel now={now} onOpenAll={() => setOpenHol(true)} />
      </section>
      <AllImportantDatesModal open={openImp} onClose={() => setOpenImp(false)} now={now} />
      <AllHolidaysModal open={openHol} onClose={() => setOpenHol(false)} now={now} />
    </>
  )
}