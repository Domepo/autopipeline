import { Children, cloneElement, isValidElement, useId, useState } from 'react'
import type { ComponentProps, FormEvent, InputHTMLAttributes, OptionHTMLAttributes, ReactNode } from 'react'
import { AlertTriangle, CheckCircle2, XCircle } from 'lucide-react'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge as UIBadge } from '@/components/ui/badge'
import { Button as UIButton } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input as UIInput } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select as UISelect, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { cn } from '@/lib/utils'

type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger'

export function Button({ variant = 'primary', icon, children, ...props }: Omit<ComponentProps<typeof UIButton>, 'variant'> & { variant?: ButtonVariant; icon?: ReactNode }) {
  const mapped = variant === 'primary' ? 'default' : variant === 'danger' ? 'destructive' : variant
  return <UIButton variant={mapped} {...props}>{icon}{children}</UIButton>
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) { return <UIInput {...props} /> }

const emptySelectValue = '__asc_empty_select_value__'

type SelectProps = {
  children: ReactNode
  className?: string
  name?: string
  value?: string
  defaultValue?: string
  disabled?: boolean
  required?: boolean
  autoFocus?: boolean
  id?: string
  title?: string
  'aria-label'?: string
  onChange?: (event: { target: { value: string } }) => void
}

export function Select({ children, className, name, value, defaultValue, disabled, required, autoFocus, id, title, onChange, 'aria-label': ariaLabel }: SelectProps) {
  const options = Children.toArray(children)
    .filter((child) => isValidElement<OptionHTMLAttributes<HTMLOptionElement>>(child) && child.type === 'option')
    .map((child) => {
      const option = child as React.ReactElement<OptionHTMLAttributes<HTMLOptionElement>>
      return { value: String(option.props.value ?? option.props.children ?? ''), label: option.props.children, disabled: option.props.disabled ?? false }
    })
  const [internalValue, setInternalValue] = useState(defaultValue ?? options.find((option) => !option.disabled)?.value ?? options[0]?.value ?? '')
  const selectedValue = value ?? (options.some((option) => option.value === internalValue) ? internalValue : options.find((option) => !option.disabled)?.value ?? '')
  return <>
    <UISelect name={name} value={selectedValue === '' ? emptySelectValue : selectedValue} disabled={disabled} required={required} onValueChange={(nextValue) => {
      const next = nextValue === emptySelectValue ? '' : nextValue
      if (value === undefined) setInternalValue(next)
      onChange?.({ target: { value: next } })
    }}>
      <SelectTrigger id={id} title={title} aria-label={ariaLabel} aria-required={required} data-required-select={required || undefined} data-empty-select={selectedValue === '' || undefined} autoFocus={autoFocus} className={cn('w-full min-w-0 bg-background', className)}><SelectValue placeholder="Auswählen …"/></SelectTrigger>
      <SelectContent className="max-h-72 w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-2rem)] p-1">
        {options.map((option, index) => <SelectItem key={`${option.value}-${index}`} value={option.value === '' ? emptySelectValue : option.value} disabled={option.disabled} className="min-w-0 [&>span:last-child]:truncate">{option.label}</SelectItem>)}
      </SelectContent>
    </UISelect>
  </>
}

export function Field({ label, hint, children, className }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  const id = useId()
  const directControl = isValidElement<{ id?: string }>(children) && (children.type === Input || children.type === Select)
  return <div className={cn('grid gap-2', className)}><Label htmlFor={directControl ? children.props.id ?? id : undefined}>{label}</Label>{directControl ? cloneElement(children, { id: children.props.id ?? id }) : children}{hint && <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>}</div>
}

export function Modal({ title, description, children, onClose, wide = false }: { title: string; description?: string; children: ReactNode; onClose: () => void; wide?: boolean }) {
  return <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
    <DialogContent className={cn('max-h-[88vh] overflow-y-auto p-0', wide && 'sm:max-w-3xl')}>
      <DialogHeader className="border-b px-6 py-5 text-left"><DialogTitle>{title}</DialogTitle>{description && <DialogDescription>{description}</DialogDescription>}</DialogHeader>
      {children}
    </DialogContent>
  </Dialog>
}

export function FormActions({ onCancel, submit = 'Speichern', busy = false, submitDisabled = false }: { onCancel: () => void; submit?: string; busy?: boolean; submitDisabled?: boolean }) {
  return <div className="ml-auto flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onCancel}>Abbrechen</Button><Button type="submit" disabled={busy || submitDisabled}>{busy ? 'Wird gespeichert …' : submit}</Button></div>
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

export function ConfirmButton({ onConfirm, title = 'Eintrag löschen', description = 'Diese Aktion kann nicht rückgängig gemacht werden.', children = 'Löschen', variant = 'danger', ...props }: Omit<ComponentProps<typeof Button>, 'onClick' | 'type'> & { onConfirm: () => void | Promise<void>; title?: string; description?: string }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const confirm = async () => {
    setBusy(true)
    setError(null)
    try { await onConfirm(); setOpen(false) }
    catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  return <><Button {...props} variant={variant} type="button" onClick={() => setOpen(true)}>{children}</Button>{open && <Modal title={title} description={description} onClose={() => { if (!busy) setOpen(false) }}><div className="grid gap-4 px-6 py-5"><Notice tone="warning" title="Bitte bestätigen">{description}</Notice>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}</div><div className="flex justify-end gap-2 border-t bg-muted/20 px-6 py-4"><Button variant="ghost" disabled={busy} onClick={() => setOpen(false)}>Abbrechen</Button><Button variant="danger" disabled={busy} onClick={() => void confirm()}>{busy ? 'Wird gelöscht …' : title}</Button></div></Modal>}</>
}

export function PageHeader({ eyebrow, title, description, actions }: { eyebrow: string; title: string; description: string; actions?: ReactNode }) {
  return <header className="mb-6 flex flex-wrap items-start justify-between gap-4"><div><p className="mb-1 text-xs font-medium uppercase tracking-wider text-muted-foreground">{eyebrow}</p><h1 className="text-2xl font-semibold tracking-tight">{title}</h1><p className="mt-1 text-sm text-muted-foreground">{description}</p></div>{actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}</header>
}

export function submitForm(handler: (data: FormData) => void | Promise<void>) { return (event: FormEvent<HTMLFormElement>) => { event.preventDefault(); const missingSelect = event.currentTarget.querySelector<HTMLButtonElement>('[data-required-select="true"][data-empty-select="true"]'); if (missingSelect) { missingSelect.focus(); return } const data = new FormData(event.currentTarget); for (const [key, value] of data.entries()) if (value === emptySelectValue) data.set(key, ''); void handler(data) } }

export function formatDate(value?: string) {
  if (!value) return '–'
  return new Intl.DateTimeFormat('de-DE', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(value))
}

export function formatBytes(value: number) {
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`
  return `${(value / 1024 / 1024).toFixed(1)} MB`
}
