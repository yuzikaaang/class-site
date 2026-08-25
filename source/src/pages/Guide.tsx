import { useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { isWeChat, isValidHttpUrl, copyText } from '@/lib/wechat'
import { Button } from '@/components/ui/button'
import { Copy, Check, Home, Loader2, ExternalLink } from 'lucide-react'

/**
 * 微信跳转引导页 / 外部跳转页
 *
 * 流程：微信内点击「不兼容链接」→ 来到本页 → 提示点右上角【···】在浏览器打开
 *      → 系统浏览器打开本页 → 检测到非微信 → 自动跳转目标链接
 */
export default function Guide() {
  const [params] = useSearchParams()
  const url = (params.get('url') || '').trim()
  const valid = isValidHttpUrl(url)
  const wechat = useMemo(() => isWeChat(), [])
  const [copied, setCopied] = useState(false)

  let host = ''
  try {
    host = valid ? new URL(url).hostname : ''
  } catch {
    host = ''
  }

  /* 非微信环境（已通过浏览器打开）→ 自动跳转目标页 */
  useEffect(() => {
    if (!valid || wechat) return
    const timer = setTimeout(() => {
      window.location.replace(url)
    }, 900)
    return () => clearTimeout(timer)
  }, [valid, wechat, url])

  const handleCopy = async () => {
    const ok = await copyText(url)
    if (ok) {
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }

  /* 参数无效 */
  if (!valid) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-[#f5f7fa] to-[#d5dce5] p-6">
        <div className="w-full max-w-sm rounded-3xl bg-white p-8 text-center shadow-lg">
          <span className="mb-3 block text-4xl">🤔</span>
          <h2 className="mb-2 text-xl font-bold text-[#2c3e50]">链接参数无效</h2>
          <p className="mb-6 text-sm text-gray-500">请从班级服务站的卡片重新进入</p>
          <Link to="/">
            <Button className="w-full rounded-full bg-[#4a6cf7] hover:bg-[#3b5bfd]">返回首页</Button>
          </Link>
        </div>
      </div>
    )
  }

  /* 系统浏览器环境：自动跳转 */
  if (!wechat) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-[#f5f7fa] to-[#d5dce5] p-6">
        <div className="w-full max-w-sm rounded-3xl bg-white p-8 text-center shadow-lg">
          <Loader2 className="mx-auto mb-4 h-10 w-10 animate-spin text-[#4a6cf7]" />
          <h2 className="mb-2 text-xl font-bold text-[#2c3e50]">正在为您跳转</h2>
          <p className="mb-1 text-sm text-gray-500">目标站点</p>
          <p className="mb-6 break-all font-mono text-sm font-semibold text-[#3b5bfd]">{host}</p>
          <a href={url} target="_blank" rel="noopener noreferrer" className="block">
            <Button className="w-full rounded-full bg-[#4a6cf7] hover:bg-[#3b5bfd]">
              <ExternalLink className="mr-2 h-4 w-4" /> 若未自动跳转，点此前往
            </Button>
          </a>
          <Link to="/" className="mt-4 inline-block text-xs text-gray-400 hover:text-[#4a6cf7]">
            返回班级服务站
          </Link>
        </div>
      </div>
    )
  }

  /* 微信环境：显示引导 */
  return (
    <div className="relative flex min-h-screen items-center justify-center bg-white px-5 py-10">
      {/* 右上角指向【···】的提示 */}
      <div className="absolute right-4 top-4 flex animate-bounce flex-col items-end">
        <span className="mb-1 rounded-full bg-[#4a6cf7] px-3 py-1 text-xs font-semibold text-white shadow-md">
          菜单在这里 ↑
        </span>
        <svg width="46" height="46" viewBox="0 0 46 46" className="text-[#3b5bfd]">
          <path
            d="M8 38 L36 10 M36 10 L36 26 M36 10 L20 10"
            stroke="currentColor"
            strokeWidth="4"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
          />
        </svg>
      </div>

      <div className="w-full max-w-md rounded-3xl bg-white p-8 text-center shadow-[0_8px_30px_rgba(0,0,0,0.08)]">
        <span className="mb-3 block text-4xl">🌐</span>
        <h2 className="mb-4 text-2xl font-bold text-[#222]">需要使用浏览器打开</h2>
        <p className="leading-8 text-[#555]">
          该站点（{host}）在微信内置浏览器中无法直接访问
          <br />
          请按以下步骤切换到系统浏览器
        </p>

        <div className="mt-6 space-y-3 rounded-2xl bg-[#fff7ed] p-5 text-left">
          <p className="flex items-start gap-3 text-[#c2410c]">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#c2410c] text-sm font-bold text-white">
              1
            </span>
            <span className="leading-6">点击屏幕右上角的【···】按钮</span>
          </p>
          <p className="flex items-start gap-3 text-[#c2410c]">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#c2410c] text-sm font-bold text-white">
              2
            </span>
            <span className="leading-6">
              在弹出菜单中选择 <strong>「在浏览器打开」</strong>
            </span>
          </p>
          <p className="flex items-start gap-3 text-[#c2410c]">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[#c2410c] text-sm font-bold text-white">
              3
            </span>
            <span className="leading-6">浏览器打开后将自动跳转到目标页面</span>
          </p>
        </div>

        <Button
          onClick={handleCopy}
          variant="outline"
          className="mt-6 w-full rounded-full border-[#4a6cf7] text-[#3b5bfd] hover:bg-[#eef1ff]"
        >
          {copied ? <Check className="mr-2 h-4 w-4" /> : <Copy className="mr-2 h-4 w-4" />}
          {copied ? '已复制，可粘贴到浏览器' : '复制目标链接'}
        </Button>

        <Link to="/" className="mt-4 inline-block text-sm text-gray-400 hover:text-[#4a6cf7]">
          <Home className="mr-1 inline h-4 w-4" /> 返回班级服务站
        </Link>
      </div>
    </div>
  )
}
