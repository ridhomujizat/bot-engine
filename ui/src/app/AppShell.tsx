import { Code2, LogOut, Package, Square, Workflow } from 'lucide-react'
import type { ReactNode } from 'react'
import { Outlet, useNavigate, useParams } from 'react-router'
import { logout } from '@/api/auth'
import { cn } from '@/lib/utils'

/** App chrome: the 48px top bar with breadcrumbs, and the 48px icon rail on the left. */
export function AppShell() {
  return (
    <div className="flex h-full flex-col">
      <Outlet />
    </div>
  )
}

export interface TopbarProps {
  crumbs: string[]
  actions?: ReactNode
  status?: ReactNode
}

export function Topbar({ crumbs, actions, status }: TopbarProps) {
  return (
    <header className="flex h-12 shrink-0 items-center gap-2.5 border-b border-border bg-background px-3">
      <div className="flex size-6 items-center justify-center rounded-md bg-primary text-primary-foreground">
        <Square className="size-3.5" />
      </div>
      <span className="text-sm font-semibold">Bot Engine</span>
      {crumbs.map((crumb, i) => {
        const last = i === crumbs.length - 1
        return (
          <span key={`${crumb}-${i}`} className="flex items-center gap-2.5">
            <span className="text-ring">/</span>
            <span className={cn(last ? 'font-medium text-foreground' : 'text-muted-foreground')}>{crumb}</span>
          </span>
        )
      })}
      <div className="flex-1" />
      {status}
      {actions}
      <div className="flex size-7 items-center justify-center rounded-full bg-muted text-[11px] font-medium text-muted-foreground">RA</div>
    </header>
  )
}

export type RailKey = 'flow' | 'code' | 'bots'

export function Rail({ active }: { active: RailKey }) {
  const navigate = useNavigate()
  const { botId } = useParams()
  const item = (key: RailKey | null, icon: ReactNode, label: string, onClick: () => void) => (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className={cn(
        'flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground',
        key !== null && active === key && 'bg-muted text-foreground',
      )}
    >
      {icon}
    </button>
  )
  return (
    <nav className="flex w-12 shrink-0 flex-col items-center gap-1 border-r border-border bg-background py-2">
      {item('flow', <Workflow className="size-[18px]" />, 'Flows', () => navigate(`/bots/${botId ?? ''}/flows`))}
      {item('code', <Code2 className="size-[18px]" />, 'Code', () => navigate(`/bots/${botId ?? ''}/code`))}
      <div className="flex-1" />
      {item('bots', <Package className="size-[18px]" />, 'Bots', () => navigate('/'))}
      {item(null, <LogOut className="size-[18px]" />, 'Sign out', () => {
        logout()
        navigate('/login', { replace: true })
      })}
    </nav>
  )
}
