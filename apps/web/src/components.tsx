import type { ComponentProps, FormEvent, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from 'react'
import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge as UIBadge } from '@/components/ui/badge'
import { Button as UIButton } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input as UIInput } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

export function Button({ variant = 'primary', icon, children, ...props }: Omit<ComponentProps<typeof UIButton>, 'variant'> & { variant?: ButtonVariant; icon?: ReactNode }) {
  const mapped = variant === 'primary' ? 'default' : variant === 'danger' ? 'destructive' : variant
  return <UIButton variant={mapped} {...props}>{icon}{children}</UIButton>
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) { return <UIInput {...props} /> }

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn('h-8 w-full rounded-lg border border-input bg-background px-2.5 text-sm outline-none transition focus:border-ring focus:ring-3 focus:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-50', className)} {...props} />
}

export function Field({ label, hint, children, className }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return <div className={cn('grid gap-2', className)}><Label>{label}</Label>{children}{hint && <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>}</div>
}

export function Modal({ title, description, children, onClose, wide = false }: { title: string; description?: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  return <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
    <DialogContent className={cn('max-h-[88vh] overflow-y-auto p-0', wide && 'sm:max-w-3xl')}>
      <DialogHeader className="border-b px-6 py-5 text-left"><DialogTitle>{title}</DialogTitle>{description && <DialogDescription>{description}</DialogDescription>}</DialogHeader>
      {children}
    </DialogContent>
  </Dialog>
}

export function FormActions({ onCancel, submit = 'Speichern', busy = false }: { onCancel: () => void; submit?: string; busy?: boolean }) {
  return <div className="ml-auto flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onCancel}>Abbrechen</Button><Button type="submit" disabled={busy}>{busy ? 'Wird gespeichert …' : submit}</Button></div>
}

export function Empty({ icon, title, text, action, compact = false }: { icon: ReactNode; title: string; text: string; action?: ReactNode; compact?: boolean }) {
  return <div className={cn('flex flex-col items-center justify-center px-6 text-center', compact ? 'min-h-44 py-8' : 'min-h-80 py-12')}><div className="mb-4 grid size-10 place-items-center rounded-lg border bg-muted/50 text-muted-foreground">{icon}</div><h3 className="text-sm font-semibold">{title}</h3><p className="mt-1 max-w-md text-sm leading-relaxed text-muted-foreground">{text}</p>{action && <div className="mt-5">{action}</div>}</div>
}

const badgeTone = {
  neutral: 'border-border bg-muted text-muted-foreground',
  info: 'border-blue-200 bg-blue-50 text-blue-700',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  warning: 'border-amber-200 bg-amber-50 text-amber-700',
  danger: 'border-red-200 bg-red-50 text-red-700',
}

export function Badge({ children, tone = 'neutral', className }: { children: ReactNode; tone?: keyof typeof badgeTone; className?: string }) {
  return <UIBadge variant="outline" className={cn('font-medium', badgeTone[tone], className)}>{children}</UIBadge>
}

export function Notice({ tone = 'info', title, children }: { tone?: 'info' | 'warning' | 'danger' | 'success'; title: string; children: ReactNode }) {
  const Icon = tone === 'success' ? CheckCircle2 : tone === 'danger' ? XCircle : AlertTriangle
  const style = tone === 'danger' ? 'border-red-200 bg-red-50 text-red-900' : tone === 'warning' ? 'border-amber-200 bg-amber-50 text-amber-900' : tone === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-900' : 'border-blue-200 bg-blue-50 text-blue-900'
  return <Alert className={style}><Icon/><AlertTitle>{title}</AlertTitle><AlertDescription>{children}</AlertDescription></Alert>
}

export function ConfirmButton({ onConfirm, children = 'Löschen' }: { onConfirm: () => void; children?: ReactNode }) {
  return <Button variant="danger" type="button" onClick={() => window.confirm('Wirklich löschen? Diese Aktion kann nicht rückgängig gemacht werden.') && onConfirm()}>{children}</Button>
}

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow: string; title: string; description: string; actions?: ReactNode }) {
  return <header className="mb-6 flex flex-wrap items-start justify-between gap-4"><div><p className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">{eyebrow}</p><h1 className="text-2xl font-semibold tracking-tight">{title}</h1><p className="mt-1 text-sm text-muted-foreground">{description}</p></div>{actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}</header>
}

export function submitForm(handler: (data: FormData) => void | Promise<void>) { return (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); void handler(new FormData(event.currentTarget)) } }

export function formatDate(value?: string) {
  if (!value) return '–'
  return new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value))
}

export function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}
