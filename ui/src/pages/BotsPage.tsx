import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, MessageSquare, Upload } from 'lucide-react'
import { useState, type ChangeEvent, type DragEvent, type FormEvent } from 'react'
import { useNavigate } from 'react-router'
import { exportBot, importBot, listBots } from '@/api/bots'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import type { Bot } from '@/api/types'
import { Topbar } from '@/app/AppShell'
import { downloadBlob } from '@/lib/download'
import { cn } from '@/lib/utils'

export function BotsPage() {
  const [importOpen, setImportOpen] = useState(false)
  const navigate = useNavigate()
  const bots = useQuery({ queryKey: ['bots'], queryFn: listBots })

  const exportMutation = useMutation({
    mutationFn: async (botId: string) => {
      const { blob, filename } = await exportBot(botId)
      downloadBlob(blob, filename ?? `bot_${botId}.tgz`)
    },
  })

  return (
    <>
      <Topbar crumbs={['example-bot']} />
      <main className="mx-auto flex w-full max-w-[1040px] flex-1 flex-col gap-5 overflow-y-auto px-4 py-10">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <h1 className="text-[22px] font-semibold">Bots</h1>
            <p className="text-[13px] text-muted-foreground">Bots stored in bots_example</p>
          </div>
          <Button variant="outline" onClick={() => setImportOpen(true)}>
            <Upload /> Import .tgz
          </Button>
        </div>

        {bots.isError && <p role="alert" className="text-[13px] text-red">{bots.error.message}</p>}
        {exportMutation.isError && <p role="alert" className="text-[13px] text-red">{exportMutation.error.message}</p>}

        <div className="overflow-hidden rounded-[10px] border border-border bg-background">
          <table className="w-full border-collapse text-[13px]">
            <thead className="bg-canvas text-left text-xs text-muted-foreground">
              <tr className="h-10">
                <th className="px-4 font-medium">Name</th>
                <th className="w-[220px] px-4 font-medium">Bot ID</th>
                <th className="w-[160px] px-4 font-medium">Category</th>
                <th className="w-[250px] px-4 font-medium" />
              </tr>
            </thead>
            <tbody>
              {(bots.data ?? []).map((bot: Bot) => (
                <tr key={bot.id} className="h-[52px] border-t border-border">
                  <td className="px-4">
                    <div className="flex items-center gap-2.5 font-medium">
                      <span className="flex size-7 items-center justify-center rounded-[7px] bg-muted">
                        <MessageSquare className="size-3.5 text-muted-foreground" />
                      </span>
                      {bot.name}
                    </div>
                  </td>
                  <td className="px-4 font-mono-code text-xs text-muted-foreground">{bot.id}</td>
                  <td className="px-4 text-muted-foreground">{bot.category || '-'}</td>
                  <td className="px-4">
                    <div className="flex justify-end gap-1.5">
                      <Button variant="outline" size="sm" onClick={() => navigate(`/bots/${encodeURIComponent(bot.id)}/flows`)}>
                        Open editor
                      </Button>
                      <Button variant="ghost" size="sm" disabled={exportMutation.isPending} onClick={() => exportMutation.mutate(bot.id)}>
                        <Download /> Export
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </main>

      <ImportBotDialog open={importOpen} onOpenChange={setImportOpen} />
    </>
  )
}

const ARCHIVE_TYPES = ['.tgz', '.tar.gz', '.zip']

function ImportBotDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const queryClient = useQueryClient()
  const [file, setFile] = useState<File | null>(null)
  const [botId, setBotId] = useState('')
  const [overwrite, setOverwrite] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const mutation = useMutation({
    mutationFn: () => importBot(botId, file as File, overwrite),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['bots'] })
      onOpenChange(false)
      reset()
    },
    onError: (err: Error) => setError(err.message),
  })

  function reset() {
    setFile(null)
    setBotId('')
    setOverwrite(false)
    setError(null)
  }

  function pick(candidate: File | undefined) {
    if (!candidate) return
    if (!ARCHIVE_TYPES.some((ext) => candidate.name.toLowerCase().endsWith(ext))) {
      setError('Choose a .tgz or .zip archive exported from legacy or Bot Engine')
      return
    }
    setError(null)
    setFile(candidate)
    setBotId(candidate.name.replace(/\.(tgz|tar\.gz|zip)$/i, '').replace(/^bot_|_\d+$/g, ''))
  }

  function drop(event: DragEvent) {
    event.preventDefault()
    setDragging(false)
    pick(event.dataTransfer.files[0])
  }

  function submit(event: FormEvent) {
    event.preventDefault()
    if (file && botId) mutation.mutate()
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) reset()
      }}
    >
      <DialogContent
        title="Import bot"
        description="Creates a bot from an archive. Flows, actions and content are checked before saving."
        footer={
          <>
            <Button variant="outline" type="button" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" form="import-bot-form" disabled={!file || !botId || mutation.isPending}>
              Import bot
            </Button>
          </>
        }
      >
        <form id="import-bot-form" onSubmit={submit} className="grid gap-4">
          <label
            onDragOver={(e) => {
              e.preventDefault()
              setDragging(true)
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={drop}
            className={cn(
              'flex cursor-pointer flex-col items-center gap-2 rounded-[10px] border border-dashed border-ring bg-canvas px-4 py-7 text-center',
              dragging && 'border-primary',
            )}
          >
            <span className="flex size-10 items-center justify-center rounded-full bg-muted">
              <Upload className="size-5 text-muted-foreground" />
            </span>
            <span className="text-[13px] font-medium">Drop a bot archive here, or browse</span>
            <span className="text-xs text-muted-foreground">.tgz or .zip exported from legacy or Bot Engine</span>
            <input
              type="file"
              accept=".tgz,.tar.gz,.zip"
              className="sr-only"
              onChange={(e: ChangeEvent<HTMLInputElement>) => pick(e.target.files?.[0])}
            />
          </label>
          {file && (
            <p className="rounded-lg border border-border p-2.5 text-xs">
              <span className="font-mono-code">{file.name}</span>
              <span className="ml-2 text-muted-foreground">{(file.size / 1024 / 1024).toFixed(1)} MB</span>
            </p>
          )}
          <div className="grid gap-1.5">
            <Label htmlFor="import-bot-id">Bot ID</Label>
            <Input id="import-bot-id" className="font-mono-code" value={botId} onChange={(e) => setBotId(e.target.value)} />
          </div>
          <div className="flex items-center gap-2.5">
            <Switch id="import-overwrite" checked={overwrite} onCheckedChange={setOverwrite} />
            <Label htmlFor="import-overwrite" className="font-normal">Overwrite if the bot already exists</Label>
          </div>
          {error && <p role="alert" className="text-[13px] text-red">{error}</p>}
        </form>
      </DialogContent>
    </Dialog>
  )
}
