import { useMutation } from '@tanstack/react-query'
import { Square } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { login } from '@/api/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export function LoginPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const from = (location.state as { from?: string } | null)?.from ?? '/'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  const mutation = useMutation({
    mutationFn: () => login(email, password),
    onSuccess: () => navigate(from, { replace: true }),
  })

  function submit(event: FormEvent) {
    event.preventDefault()
    mutation.mutate()
  }

  return (
    <div className="flex h-full flex-col items-center justify-center bg-canvas px-4">
      <form onSubmit={submit} className="flex w-[380px] max-w-full flex-col gap-[18px] rounded-xl border border-border bg-background p-7 shadow-md">
        <div className="flex flex-col gap-2.5">
          <div className="flex size-9 items-center justify-center rounded-[9px] bg-primary text-primary-foreground">
            <Square className="size-5" />
          </div>
          <h1 className="text-xl font-semibold">Sign in to Bot Engine</h1>
          <p className="text-[13px] text-muted-foreground">Use your existing legacy account</p>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="email">Email</Label>
          <Input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="password">Password</Label>
          <Input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>
        {mutation.isError && <p role="alert" className="text-[13px] text-red">{mutation.error.message || 'Sign in failed'}</p>}
        <Button type="submit" className="h-9 w-full" disabled={mutation.isPending}>
          {mutation.isPending ? 'Signing in...' : 'Sign in'}
        </Button>
      </form>
      <p className="fixed bottom-4 text-xs text-muted-foreground">bot-engine  ·  tenant: example-bot</p>
    </div>
  )
}
