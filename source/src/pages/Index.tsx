import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { openExternal, isWeChat } from '@/lib/wechat'
import { hashSecret, xorDecrypt, GATE_SALT, CONTACT_SALT } from '@/lib/crypto'
import {
  ANNOUNCEMENTS,
  CATEGORIES,
  LINKS,
  CONTACTS,
  SITE_GATE,
  WECHAT_QR_URL,
  type SiteLink,
  type Contact,
  type Announcement,
} from '@/data/siteData'
import CountdownSection from '@/components/Countdown'
import { Button } from '@/components/ui/button'
import { Megaphone, Eye, EyeOff, Sun, Moon, Menu } from 'lucide-react'

const CLASS_LOGO = 'https://s41.ax1x.com/2026/06/07/pmmhF6H.png'

/* 每日日报：独立展示在公告下方、倒计时上方（不属于任何板块标签） */
const DAILY_LINK: SiteLink = {
  id: 4,
  categoryId: 0,
  title: '每日日报',
  description: '',
  icon: '',
  iconText: '日报',
  mainLabel: '前往查看',
  mainUrl: 'https://a288a58108efc2c2f.app.workbuddy.link',
  mainWechatOk: true,
  extraLabel: '',
  extraUrl: '',
  extraWechatOk: true,
}

/* ---------- 公告栏（只显示最近两条，其余折叠到弹窗） ---------- */
function AnnouncementBoard({ onShowQr }: { onShowQr: () => void }) {
  if (ANNOUNCEMENTS.length === 0) return null
  const [showAll, setShowAll] = useState(false)
  // 置顶公告永远排在顶部，其余保持发布时间倒序
  const sortedAnnouncements = [...ANNOUNCEMENTS].sort(
    (a, b) => Number(!!b.important) - Number(!!a.important),
  )
  const visibleAnnouncements = sortedAnnouncements.slice(0, 2)
  const hiddenCount = sortedAnnouncements.length - visibleAnnouncements.length

  const renderItem = (a: Announcement, key: number) => (
    <li key={key} className="px-5 py-3.5">
      <div className="mb-1.5 flex items-center gap-2">
        <span
          className={`shrink-0 rounded-lg px-2 py-1 text-xs font-semibold ${
            a.important
              ? 'bg-orange-100 text-[#c2410c] dark:bg-orange-900/40 dark:text-orange-300'
              : 'bg-[#eef1ff] text-[#3b5bfd] dark:bg-[#2a3550] dark:text-[#9db1ff]'
          }`}
        >
          {a.date.slice(5)}
        </span>
        {a.important && (
          <span className="inline-block rounded bg-[#c2410c] px-1.5 py-0.5 text-xs font-bold text-white">置顶</span>
        )}
      </div>
      <p
        className={`text-sm leading-6 ${
          a.important ? 'font-medium text-[#2c3e50] dark:text-slate-200' : 'text-[#4a5568] dark:text-slate-400'
        }`}
      >
        {a.text}
      </p>
    </li>
  )

  return (
    <>
      <section className="mb-7 overflow-hidden rounded-2xl bg-white shadow-[0_8px_25px_rgba(0,0,0,0.06)] dark:bg-[#1b2432]">
        <div className="flex items-center gap-2 bg-gradient-to-r from-[#4a6cf7] to-[#5d7fff] px-5 py-3">
          <Megaphone className="h-4.5 w-4.5 text-white" />
          <h2 className="text-base font-bold text-white">班级公告</h2>
          <span className="ml-auto rounded-full bg-white/20 px-2.5 py-0.5 text-xs text-white">
            {ANNOUNCEMENTS.length} 条
          </span>
          <button
            onClick={onShowQr}
            className="ml-2 rounded-full bg-[#07c160] px-3.5 py-1 text-xs font-bold text-white shadow-sm transition-transform hover:bg-[#06ad56] active:scale-95"
          >
            公众号
          </button>
        </div>
        <ul className="divide-y divide-gray-100">
          {visibleAnnouncements.map((a, i) => renderItem(a, i))}
        </ul>
        {hiddenCount > 0 && (
          <button
            onClick={() => setShowAll(true)}
            className="block w-full border-t border-gray-100 bg-gray-50 py-2.5 text-center text-sm font-semibold text-[#3b5bfd] transition-colors hover:bg-gray-100 dark:border-[#2a3550] dark:bg-[#202a3a] dark:text-[#9db1ff] dark:hover:bg-[#253047]"
          >
            查看全部 {hiddenCount} 条公告
          </button>
        )}
      </section>

      {/* 全部公告弹窗 */}
      {showAll && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-5"
          onClick={() => setShowAll(false)}
        >
          <div
            className="w-full max-w-md overflow-hidden rounded-3xl bg-white shadow-2xl dark:bg-[#1b2432]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between bg-gradient-to-r from-[#4a6cf7] to-[#5d7fff] px-5 py-3">
              <h3 className="text-base font-bold text-white">全部公告（{sortedAnnouncements.length} 条）</h3>
              <button
                onClick={() => setShowAll(false)}
                className="rounded-full bg-white/20 px-3 py-1 text-xs font-semibold text-white hover:bg-white/30"
              >
                关闭
              </button>
            </div>
            <ul className="max-h-[65vh] divide-y divide-gray-100 overflow-y-auto">
              {sortedAnnouncements.map((a, i) => renderItem(a, i))}
            </ul>
          </div>
        </div>
      )}
    </>
  )
}

/* ---------- 单张服务卡片 ---------- */
function ServiceCard({
  link,
  onOpen,
  onOpenUrl,
}: {
  link: SiteLink
  onOpen: (link: SiteLink, which: 'main' | 'extra') => void
  onOpenUrl: (url: string) => void
}) {
  const [imgError, setImgError] = useState(false)
  const inWeChat = useMemo(() => isWeChat(), [])
  const needBrowser = inWeChat && !link.mainWechatOk && Boolean(link.mainUrl.trim())
  const hasExtra = Boolean(link.extraLabel.trim())

  // 问答型资源（gate）：答对后本地记住，下次打开不用再答
  const [gateVal, setGateVal] = useState('')
  const [gatePassed, setGatePassed] = useState<boolean>(() => {
    if (!link.gate) return false
    try {
      return (
        localStorage.getItem('cls_gate_' + link.id) === 'ok' &&
        localStorage.getItem('cls_gate_' + link.id + '_v') === link.gate.version
      )
    } catch {
      return false
    }
  })
  const [gateHint, setGateHint] = useState('')
  const [showGatePwd, setShowGatePwd] = useState(false)

  // 联系方式查询
  const [contactName, setContactName] = useState('')
  const [contactResult, setContactResult] = useState<{ ok: boolean; contact?: Contact; msg?: string } | null>(null)

  const copyText = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value)
      toast.success(label + '已复制：' + value)
    } catch {
      toast.info(value)
    }
  }

  const findContact = () => {
    const n = contactName.trim()
    if (!n) {
      setContactResult({ ok: false, msg: '请输入姓名' })
      return
    }
    const nameHash = hashSecret(n, CONTACT_SALT)
    const hit = CONTACTS.find((c) => c.name === nameHash)
    if (hit) {
      setContactResult({
        ok: true,
        contact: {
          name: n,
          studentId: hit.studentId ? xorDecrypt(hit.studentId) : undefined,
          role: hit.role ? xorDecrypt(hit.role) : undefined,
          wechat: hit.wechat ? xorDecrypt(hit.wechat) : undefined,
          phone: hit.phone ? xorDecrypt(hit.phone) : undefined,
        },
      })
    } else {
      setContactResult({ ok: false, msg: '暂未找到该姓名的联系方式' })
    }
  }

  const submitGate = () => {
    if (!link.gate) return
    const v = hashSecret(gateVal, GATE_SALT)
    if (link.gate.answers.includes(v)) {
      try {
        localStorage.setItem('cls_gate_' + link.id, 'ok')
        localStorage.setItem('cls_gate_' + link.id + '_v', link.gate.version)
      } catch {
        /* 忽略本地存储不可用 */
      }
      setGatePassed(true)
      setGateHint('')
    } else {
      setGateHint(link.gate.hint)
    }
  }

  const copyCode = async () => {
    if (!link.gate) return
    try {
      await navigator.clipboard.writeText(link.gate.code)
      toast.success('访问码已复制：' + link.gate.code)
    } catch {
      toast.info('复制失败，访问码：' + link.gate.code)
    }
  }

  return (
    <div className="group flex flex-col items-center gap-5 rounded-[20px] border-t-4 border-[#4a6cf7] bg-white p-6 shadow-[0_8px_25px_rgba(0,0,0,0.06)] transition-all duration-300 hover:-translate-y-1 hover:shadow-[0_15px_35px_rgba(59,91,253,0.12)] dark:bg-[#1b2432] dark:shadow-[0_8px_25px_rgba(0,0,0,0.4)] md:flex-row md:items-center md:gap-6 md:p-7 md:text-left">
      {/* 图标 */}
      <div className="flex h-20 w-20 shrink-0 items-center justify-center">
        {link.icon && !imgError ? (
          <img
            src={link.icon}
            alt={link.title}
            className="h-20 w-20 object-contain"
            onError={() => setImgError(true)}
          />
        ) : (
          <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-gradient-to-br from-[#4a6cf7] to-[#3b5bfd] px-1 text-center text-xl font-bold text-white">
            {link.iconText || link.title?.charAt(0) || '🔗'}
          </div>
        )}
      </div>

      {/* 内容 */}
      <div className="flex-1 text-center md:text-left">
        <h3 className="mb-2 text-xl font-bold text-[#3b5bfd] dark:text-[#9db1ff]">{link.title}</h3>
        {link.subtitle && (
          <p className="mt-0.5 mb-2 text-xs font-semibold text-[#9aa7b8] dark:text-slate-500">{link.subtitle}</p>
        )}
        {link.description && (
          <p className="whitespace-pre-line text-[17px] leading-7 text-[#4a5568] dark:text-slate-400">{link.description}</p>
        )}
        {link.gate && !gatePassed && (
          <div className="mt-4 rounded-2xl bg-[#f3f6ff] dark:bg-[#22304a] p-4">
            <p className="mb-2.5 text-[15px] font-bold text-[#3b5bfd] dark:text-[#9db1ff]">🔒 {link.gate.question}</p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <div className="relative flex-1">
                <input
                  type={showGatePwd ? 'text' : 'password'}
                  value={gateVal}
                  onChange={(e) => setGateVal(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && submitGate()}
                  placeholder="请输入答案"
                  autoComplete="off"
                  className="h-11 w-full rounded-xl border border-[#c3d0df] bg-white px-4 pr-11 text-[15px] text-[#2c3e50] outline-none transition-colors focus:border-[#4a6cf7] dark:border-[#3a4a6b] dark:bg-[#131a26] dark:text-slate-200"
                />
                <button
                  type="button"
                  onClick={() => setShowGatePwd((s) => !s)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1.5 text-[#9aa7b8] transition-colors hover:bg-[#eef1ff] hover:text-[#3b5bfd]"
                  aria-label={showGatePwd ? '隐藏' : '显示'}
                >
                  {showGatePwd ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                </button>
              </div>
              <Button
                onClick={submitGate}
                className="h-11 shrink-0 rounded-xl bg-[#4a6cf7] px-6 font-semibold text-white shadow-md transition-all hover:scale-105 hover:bg-[#3b5bfd]"
              >
                验证答案
              </Button>
            </div>
            {gateHint && <p className="mt-2.5 text-sm font-medium text-[#c2410c]">💡 {gateHint}</p>}
          </div>
        )}
        {link.contactQuery && (
          <div className="mt-4 rounded-2xl bg-[#f3f6ff] dark:bg-[#22304a] p-4">
            <p className="mb-2.5 text-[15px] font-bold text-[#3b5bfd] dark:text-[#9db1ff]">📇 查询联系方式</p>
            <div className="flex flex-col gap-2 sm:flex-row">
              <input
                value={contactName}
                onChange={(e) => setContactName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && findContact()}
                placeholder="请输入姓名"
                className="h-11 flex-1 rounded-xl border border-[#c3d0df] bg-white px-4 text-[15px] text-[#2c3e50] outline-none transition-colors focus:border-[#4a6cf7] dark:border-[#3a4a6b] dark:bg-[#131a26] dark:text-slate-200"
              />
              <Button
                onClick={findContact}
                className="h-11 shrink-0 rounded-xl bg-[#4a6cf7] px-6 font-semibold text-white shadow-md transition-all hover:scale-105 hover:bg-[#3b5bfd]"
              >
                查询
              </Button>
            </div>
            {contactResult &&
              (contactResult.ok && contactResult.contact ? (
                <div className="mt-2.5 flex flex-col gap-2">
                  {(contactResult.contact.studentId || contactResult.contact.role) && (
                    <div className="flex flex-wrap items-center gap-2">
                    {contactResult.contact.studentId && (
                      <span className="rounded-lg bg-[#eef1ff] px-2.5 py-1 text-xs font-bold text-[#3b5bfd] dark:bg-[#2a3550] dark:text-[#9db1ff]">
                        学号 {contactResult.contact.studentId}
                      </span>
                    )}
                    {contactResult.contact.role && (
                      <span
                        className={`rounded-lg px-2.5 py-1 text-xs font-bold ${
                          contactResult.contact.role === '老师'
                            ? 'bg-orange-100 text-[#c2410c] dark:bg-orange-900/40 dark:text-orange-300'
                            : contactResult.contact.role === '管理员'
                              ? 'bg-[#e6f9f0] text-[#07a154] dark:bg-emerald-900/40 dark:text-emerald-300'
                              : 'bg-[#eef1ff] text-[#3b5bfd] dark:bg-[#2a3550] dark:text-[#9db1ff]'
                        }`}
                      >
                        {contactResult.contact.role}
                      </span>
                    )}
                    </div>
                  )}
                  {contactResult.contact.wechat && (
                    <button
                      onClick={() => copyText(contactResult.contact!.wechat!, '微信号')}
                      className="flex items-center justify-between rounded-xl bg-[#eef1ff] px-4 py-2.5 text-sm font-semibold text-[#3b5bfd] transition-colors hover:bg-[#dce3ff] dark:bg-[#2a3550] dark:text-[#9db1ff] dark:hover:bg-[#33405f]"
                    >
                      <span>微信号：{contactResult.contact.wechat}</span>
                      <span className="text-xs">📋 点击复制</span>
                    </button>
                  )}
                  {contactResult.contact.phone && (
                    <button
                      onClick={() => copyText(contactResult.contact!.phone!, '电话')}
                      className="flex items-center justify-between rounded-xl bg-[#eef1ff] px-4 py-2.5 text-sm font-semibold text-[#3b5bfd] transition-colors hover:bg-[#dce3ff] dark:bg-[#2a3550] dark:text-[#9db1ff] dark:hover:bg-[#33405f]"
                    >
                      <span>电话：{contactResult.contact.phone}</span>
                      <span className="text-xs">📋 点击复制</span>
                    </button>
                  )}
                </div>
              ) : (
                <p className="mt-2.5 text-sm font-medium text-[#c2410c]">{contactResult.msg}</p>
              ))}
          </div>
        )}
      </div>

      {/* 操作 */}
      <div className="flex w-full shrink-0 flex-col items-center gap-2.5 md:w-44">
        {link.gate ? (
          gatePassed ? (
            <>
              {link.gate.url ? (
                <Button
                  onClick={() => onOpenUrl(link.gate!.url)}
                  className="min-w-[140px] rounded-full bg-[#4a6cf7] px-6 py-2.5 font-semibold text-white shadow-md transition-all hover:scale-105 hover:bg-[#3b5bfd]"
                >
                  打开链接
                </Button>
              ) : (
                <span className="rounded-full bg-[#eef1ff] px-3 py-1 text-xs font-medium text-[#3b5bfd] dark:bg-[#2a3550] dark:text-[#9db1ff]">
                  链接待开放
                </span>
              )}
              {link.gate.code && (
                <Button
                  variant="secondary"
                  onClick={copyCode}
                  className="min-w-[140px] rounded-full bg-[#eef1ff] px-6 py-2.5 font-semibold text-[#3b5bfd] transition-all hover:scale-105 hover:bg-[#dce3ff]"
                >
                  访问码：{link.gate.code}
                </Button>
              )}
              {inWeChat && link.gate.url && (
                <span className="rounded-full bg-orange-50 px-3 py-1 text-xs font-medium text-[#c2410c] dark:bg-orange-900/30 dark:text-orange-300">
                  建议复制链接到浏览器打开
                </span>
              )}
            </>
          ) : (
            <span className="rounded-full bg-[#eef1ff] px-3 py-1 text-xs font-medium text-[#3b5bfd] dark:bg-[#2a3550] dark:text-[#9db1ff]">
              答对后获取访问码
            </span>
          )
        ) : link.comingSoon ? (
          <Button
            onClick={() => toast.info('功能开发中，敬请期待')}
            className="min-w-[140px] cursor-not-allowed rounded-full bg-[#c3d0df] px-6 py-2.5 font-semibold text-white shadow-sm dark:bg-slate-600"
          >
            {link.mainLabel?.trim() || '待开发'}
          </Button>
        ) : link.contactQuery ? (
          <span className="rounded-full bg-[#eef1ff] px-3 py-1 text-xs font-medium text-[#3b5bfd] dark:bg-[#2a3550] dark:text-[#9db1ff]">
            输入姓名查询
          </span>
        ) : (
          <>
            <Button
              onClick={() => onOpen(link, 'main')}
              className="min-w-[140px] rounded-full bg-[#4a6cf7] px-6 py-2.5 font-semibold text-white shadow-md transition-all hover:scale-105 hover:bg-[#3b5bfd]"
            >
              {link.mainLabel?.trim() || '前往入口'}
            </Button>
            {hasExtra && (
              <Button
                variant="secondary"
                onClick={() => onOpen(link, 'extra')}
                className="min-w-[140px] rounded-full bg-[#eef1ff] px-6 py-2.5 font-semibold text-[#3b5bfd] transition-all hover:scale-105 hover:bg-[#dce3ff]"
              >
                {link.extraLabel}
              </Button>
            )}
            {needBrowser && (
              <span className="rounded-full bg-orange-50 px-3 py-1 text-xs font-medium text-[#c2410c] dark:bg-orange-900/30 dark:text-orange-300">
                微信内请按引导用浏览器打开
              </span>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/* ---------- 主页面 ---------- */
export default function Index() {
  const navigate = useNavigate()
  // 主题（暗黑/亮色）
  const [isDark, setIsDark] = useState<boolean>(() => {
    try {
      return localStorage.getItem('cls_theme') === 'dark'
    } catch {
      return false
    }
  })
  useEffect(() => {
    document.documentElement.classList.toggle('dark', isDark)
    try {
      localStorage.setItem('cls_theme', isDark ? 'dark' : 'light')
    } catch {
      /* 忽略本地存储不可用 */
    }
  }, [isDark])
  const [activeView, setActiveView] = useState<number | 'home'>('home')
  const [menuOpen, setMenuOpen] = useState(false)
  const [qrImage, setQrImage] = useState<string | null>(null)
  // 站点入口问答：答对后本地记住（版本变更需重新回答）
  const [showSiteGate, setShowSiteGate] = useState<boolean>(() => {
    try {
      return localStorage.getItem('cls_site_gate') !== SITE_GATE.version
    } catch {
      return true
    }
  })
  const [siteGateAnswer, setSiteGateAnswer] = useState('')
  const [siteGateErr, setSiteGateErr] = useState('')
  const [showSitePwd, setShowSitePwd] = useState(false)

  const submitSiteGate = () => {
    const v = hashSecret(siteGateAnswer, GATE_SALT)
    if (SITE_GATE.answers.includes(v)) {
      try {
        localStorage.setItem('cls_site_gate', SITE_GATE.version)
      } catch {
        /* 忽略本地存储不可用 */
      }
      setShowSiteGate(false)
      setSiteGateErr('')
    } else {
      setSiteGateErr(SITE_GATE.hint)
    }
  }
  const [showWelcome, setShowWelcome] = useState<boolean>(() => {
    try {
      return !localStorage.getItem('cls_welcome_v1')
    } catch {
      return false
    }
  })
  useEffect(() => {
    if (showWelcome) {
      try {
        localStorage.setItem('cls_welcome_v1', '1')
      } catch {
        /* 忽略本地存储不可用 */
      }
    }
  }, [showWelcome])
  const closeWelcome = () => setShowWelcome(false)

  const tabLinks = LINKS.filter((l) => l.categoryId === activeView)
  const activeCat = CATEGORIES.find((c) => c.id === activeView)

  const selectCat = (id: number) => {
    setActiveView(id)
    setMenuOpen(false)
  }
  const goHome = () => {
    setActiveView('home')
    setMenuOpen(false)
  }

  const handleOpen = (link: SiteLink, which: 'main' | 'extra') => {
    const url = which === 'main' ? link.mainUrl : link.extraUrl
    const wechatOk = which === 'main' ? link.mainWechatOk : link.extraWechatOk
    const opened = openExternal(url, wechatOk, (target) => {
      navigate(`/guide?url=${encodeURIComponent(target)}`)
    })
    if (!opened) {
      toast.info('该入口链接暂未配置，请联系管理员补充')
    }
  }

  const openGateUrl = (url: string) => {
    const opened = openExternal(url, true, (target) => {
      navigate(`/guide?url=${encodeURIComponent(target)}`)
    })
    if (!opened) {
      toast.info('该入口链接暂未配置，请联系管理员补充')
    }
  }

  return (
    <div className="relative min-h-screen overflow-hidden bg-gradient-to-br from-[#eef2fb] via-[#e8eef8] to-[#dbe5f4] transition-colors dark:from-[#131a26] dark:via-[#182130] dark:to-[#10151f]">
      {/* 氛围背景光晕 */}
      <div className="pointer-events-none fixed -left-24 -top-24 h-72 w-72 rounded-full bg-[#b9c8ff]/35 blur-3xl dark:opacity-30" />
      <div className="pointer-events-none fixed -bottom-32 -right-20 h-80 w-80 rounded-full bg-[#ffd9b0]/30 blur-3xl dark:opacity-20" />
      <div className="pointer-events-none fixed right-1/4 top-1/2 h-64 w-64 rounded-full bg-[#cdb8ff]/25 blur-3xl dark:opacity-25" />
      <div className="relative mx-auto flex w-full max-w-6xl">
        {/* 移动端抽屉遮罩 */}
        {menuOpen && (
          <div className="fixed inset-0 z-40 bg-black/50 lg:hidden" onClick={() => setMenuOpen(false)} />
        )}

        {/* 侧边栏：桌面常驻，移动端抽屉 */}
        <aside
          className={`fixed left-0 top-0 z-50 flex h-full w-64 flex-col bg-white shadow-xl transition-transform duration-300 dark:bg-[#1b2432] lg:static lg:h-auto lg:w-56 lg:translate-x-0 lg:py-5 lg:pl-5 lg:shadow-none ${
            menuOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
        >
          <div className="flex h-full flex-col gap-1 overflow-y-auto p-4 lg:h-auto">
            <div className="mb-3 rounded-xl bg-[#eef1ff] p-3 text-xs font-medium leading-5 text-[#3b5bfd] dark:bg-[#22304a] dark:text-[#9db1ff]">
              💡 站点应用入口在侧边栏中，点击下方板块即可打开
            </div>
            <button
              type="button"
              onClick={goHome}
              className={`mb-1.5 rounded-xl px-4 py-2.5 text-left text-sm font-semibold transition-colors ${
                activeView === 'home'
                  ? 'bg-[#4a6cf7] text-white shadow-md'
                  : 'bg-[#eef1ff] text-[#3b5bfd] hover:bg-[#dce3ff] dark:bg-[#2a3550] dark:text-[#9db1ff] dark:hover:bg-[#33405f]'
              }`}
            >
              🏠 首页
            </button>
            {CATEGORIES.map((cat) => (
              <button
                key={cat.id}
                type="button"
                onClick={() => selectCat(cat.id)}
                className={`mb-1.5 rounded-xl px-4 py-2.5 text-left text-sm font-semibold transition-colors ${
                  activeView === cat.id
                    ? 'bg-[#4a6cf7] text-white shadow-md'
                    : 'bg-[#eef1ff] text-[#3b5bfd] hover:bg-[#dce3ff] dark:bg-[#2a3550] dark:text-[#9db1ff] dark:hover:bg-[#33405f]'
                }`}
              >
                {cat.name}
              </button>
            ))}
          </div>
        </aside>

        {/* 主内容 */}
        <main className="min-w-0 flex-1 px-4 py-5">
          {/* 头部 */}
          <header className="relative mb-5 overflow-hidden rounded-3xl bg-gradient-to-br from-[#4a6cf7] to-[#3b5bfd] px-6 py-10 text-center text-white shadow-[0_10px_30px_rgba(59,91,253,0.25)] md:py-12">
            <div className="pointer-events-none absolute -right-8 -top-8 h-40 w-40 rounded-full bg-white/10" />
            <div className="pointer-events-none absolute -bottom-10 -left-6 h-36 w-36 rounded-full bg-white/10" />
            {/* 移动端菜单按钮 */}
            <button
              type="button"
              onClick={() => setMenuOpen(true)}
              className="absolute left-4 top-4 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-white/20 text-white shadow-md backdrop-blur-sm transition-transform hover:scale-105 hover:bg-white/30 active:scale-95 lg:hidden"
              aria-label="打开侧边栏"
            >
              <Menu className="h-5 w-5" />
            </button>
            {/* 主题切换 */}
            <button
              onClick={() => setIsDark((v) => !v)}
              className="absolute right-4 top-4 z-10 flex h-10 w-10 items-center justify-center rounded-full bg-white/20 text-white shadow-md backdrop-blur-sm transition-transform hover:scale-105 hover:bg-white/30 active:scale-95 md:right-24 md:top-6 lg:right-5"
              aria-label="切换主题"
            >
              {isDark ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
            </button>
            <img
              src={CLASS_LOGO}
              alt="班徽"
              onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')}
              className="relative mx-auto mb-2 h-14 w-14 rounded-full border-[3px] border-white/60 bg-white object-cover shadow-lg md:absolute md:right-5 md:top-5 md:mb-0 md:h-16 md:w-16 lg:right-5 lg:top-5 lg:h-20 lg:w-20"
            />
            <h1 className="text-2xl font-extrabold tracking-wide drop-shadow-md md:text-4xl">
              🏫 25级05班班级服务站
            </h1>
            <p className="mt-2 text-sm opacity-95 md:text-lg">一站式获取班级服务 · 资源 · 工具</p>
          </header>

          {activeView === 'home' ? (
            <>
              {/* 公告栏 */}
              <AnnouncementBoard onShowQr={() => setQrImage(WECHAT_QR_URL)} />

              {/* 每日日报（独立区域） */}
              <section className="mb-7 flex items-center gap-3 overflow-hidden rounded-2xl bg-white px-5 py-4 shadow-[0_8px_25px_rgba(0,0,0,0.06)] dark:bg-[#1b2432]">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-gradient-to-br from-[#4a6cf7] to-[#3b5bfd] text-lg font-bold text-white">
                  日报
                </div>
                <div className="min-w-0 flex-1">
                  <h2 className="text-base font-bold text-[#3b5bfd] dark:text-[#9db1ff]">每日日报</h2>
                  <p className="truncate text-sm text-[#4a5568] dark:text-slate-400">每日自动整理的实时热点</p>
                </div>
                <Button
                  onClick={() => handleOpen(DAILY_LINK, 'main')}
                  className="shrink-0 rounded-full bg-[#4a6cf7] px-5 py-2.5 font-semibold text-white shadow-md transition-all hover:scale-105 hover:bg-[#3b5bfd]"
                >
                  前往查看
                </Button>
              </section>

              {/* 倒计时 */}
              <CountdownSection />
            </>
          ) : (
            <>
              {/* 板块页头部 */}
              <div className="mb-5 flex items-center justify-between">
                <h2 className="text-xl font-bold text-[#3b5bfd] dark:text-[#9db1ff]">{activeCat?.name}</h2>
                <button
                  type="button"
                  onClick={goHome}
                  className="rounded-full bg-white px-4 py-1.5 text-xs font-semibold text-[#3b5bfd] shadow transition-transform hover:scale-105 dark:bg-[#1b2432] dark:text-[#9db1ff]"
                >
                  ← 返回首页
                </button>
              </div>
              {/* 板块内容 */}
              <main className="flex flex-col gap-5">
                {tabLinks.length === 0 ? (
                  <div className="rounded-[20px] border-2 border-dashed border-[#c3d0df] bg-[#f8fafc]/80 p-10 text-center text-[#90a4ae] dark:border-[#3a4a6b] dark:bg-[#1b2432]/60 dark:text-slate-500">
                    <span className="mb-2 block text-3xl">➕</span>
                    该板块内容正在筹备中，敬请期待
                  </div>
                ) : (
                  tabLinks.map((link) => (
                    <ServiceCard key={link.id} link={link} onOpen={handleOpen} onOpenUrl={openGateUrl} />
                  ))
                )}
              </main>
            </>
          )}

          {/* 页脚 */}
          <footer className="mt-10 pb-6 text-center">
            <p className="font-medium text-[#3b5bfd] dark:text-[#9db1ff]">© 25级05班班级服务站</p>
            <p className="mt-1 text-xs text-[#9aa7b8] dark:text-slate-500">内容更新请联系管理员 · 全站可在微信内直接访问</p>
            <p className="mt-0.5 text-xs text-[#9aa7b8] dark:text-slate-500">页面由 Work Buddy 辅助生成</p>
          </footer>
        </main>
      </div>

      {/* 站点入口问答（首次进入需回答） */}
      {showSiteGate && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/70 p-6">
          <div className="w-full max-w-sm rounded-3xl bg-white p-7 text-center shadow-2xl dark:bg-[#1b2432]">
            <p className="mb-1 text-3xl">🔒</p>
            <h2 className="mb-2 text-lg font-bold text-[#2c3e50] dark:text-slate-200">进入班级服务站</h2>
            <p className="mb-4 text-sm leading-6 text-[#4a5568] dark:text-slate-400">{SITE_GATE.question}</p>
            <div className="relative">
              <input
                type={showSitePwd ? 'text' : 'password'}
                value={siteGateAnswer}
                onChange={(e) => setSiteGateAnswer(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submitSiteGate()}
                placeholder="请输入答案"
                autoFocus
                autoComplete="off"
                className="h-12 w-full rounded-xl border border-[#c3d0df] bg-white px-4 pr-12 text-[15px] text-[#2c3e50] outline-none transition-colors focus:border-[#4a6cf7] dark:border-[#3a4a6b] dark:bg-[#131a26] dark:text-slate-200"
              />
              <button
                type="button"
                onClick={() => setShowSitePwd((s) => !s)}
                className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full p-1.5 text-[#9aa7b8] transition-colors hover:bg-[#eef1ff] hover:text-[#3b5bfd]"
                aria-label={showSitePwd ? '隐藏' : '显示'}
              >
                {showSitePwd ? <EyeOff className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
              </button>
            </div>
            <Button
              onClick={submitSiteGate}
              className="mt-3 w-full rounded-xl bg-[#4a6cf7] px-6 py-2.5 font-semibold text-white shadow-md transition-all hover:scale-[1.02] hover:bg-[#3b5bfd]"
            >
              验证进入
            </Button>
            {siteGateErr && <p className="mt-2.5 text-sm font-medium text-[#c2410c]">💡 提示：{siteGateErr}</p>}
          </div>
        </div>
      )}

      {/* 首次打开欢迎弹窗 */}
      {showWelcome && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-6"
          onClick={closeWelcome}
        >
          <div
            className="w-full max-w-sm rounded-3xl bg-gradient-to-br from-[#4a6cf7] to-[#3b5bfd] p-7 text-center text-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <p className="mb-3 text-xl font-extrabold leading-relaxed">欢迎来到5班服务站 ✧⁺⸜(●˙▾˙●)⸝⁺✧</p>
            <p className="mb-4 text-sm leading-7 opacity-95">
              这里汇总咱们班级线上常用工具，后续功能也会持续更新维护！
            </p>
            <div className="mb-4 rounded-2xl bg-white/15 p-4 text-left">
              <p className="mb-2 text-sm font-bold">站内现有功能一览</p>
              <p className="text-sm leading-7 opacity-95">
                ▫ 班级点歌台<br />
                ▫ 作业查询<br />
                ▫ 班级大屏应用跳转<br />
                ▫ 每日日报资讯<br />
                ▫ 考试 / 假期倒计时<br />
                ▫ 班级重要公告<br />
                …………等待开发
              </p>
            </div>
            <p className="mb-5 text-sm leading-7 opacity-95">
              所有班级通知、线上工具都会同步在这里，记得常来看看哦~<br />
              ✨ 祝你新学期一切顺利！
            </p>
            <button
              onClick={closeWelcome}
              className="rounded-full bg-white px-8 py-2.5 text-sm font-bold text-[#3b5bfd] shadow-md transition-transform hover:scale-105"
            >
              进入服务站
            </button>
          </div>
        </div>
      )}

      {/* 公众号二维码弹窗 */}
      {qrImage && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
          onClick={() => setQrImage(null)}
        >
          <div
            className="w-full max-w-sm rounded-3xl bg-white p-6 text-center shadow-2xl dark:bg-[#1b2432]"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-3 flex items-center justify-center">
              <span className="text-base font-bold text-[#07c160]">班级公众号</span>
            </div>
            <img
              src={qrImage}
              alt="班级公众号二维码"
              className="mx-auto aspect-square w-full max-w-[240px] rounded-2xl border border-gray-200 object-contain dark:border-[#3a4a6b]"
            />
            <p className="mt-4 text-sm font-medium text-[#2c3e50] dark:text-slate-200">长按二维码，选择「识别图中二维码」关注</p>
            <p className="mt-1 text-xs text-gray-400 dark:text-slate-500">右上角「···」可转发给同学</p>
          </div>
        </div>
      )}
    </div>
  )
}
