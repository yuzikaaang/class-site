/**
 * WeChat webview detection & external-link routing
 */

/** Detect WeChat built-in browser (MicroMessenger UA) */
export function isWeChat(): boolean {
  if (typeof navigator === 'undefined') return false
  return /micromessenger/i.test(navigator.userAgent)
}

/** Only http(s) links are allowed for the guide page */
export function isValidHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test((url || '').trim())
}

/**
 * Open an external link with WeChat compatibility routing.
 *
 * - link not configured (empty / '#') → returns false, caller shows a hint
 * - in WeChat & link not WeChat-compatible → caller shows the guide page
 * - in WeChat & compatible → navigate current webview (window.open is unreliable in WeChat)
 * - normal browser → open in new tab
 */
export function openExternal(
  url: string,
  wechatCompatible: boolean,
  onNeedGuide: (url: string) => void
): boolean {
  const target = (url || '').trim()
  if (!target || target === '#') return false

  if (isWeChat()) {
    if (!wechatCompatible) {
      onNeedGuide(target)
    } else {
      window.location.href = target
    }
  } else {
    window.open(target, '_blank', 'noopener,noreferrer')
  }
  return true
}

/** Copy text to clipboard with legacy fallback (works in WeChat webview) */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* fall through */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.focus()
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}
