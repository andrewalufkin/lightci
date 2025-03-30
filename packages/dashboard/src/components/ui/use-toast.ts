// Adapted from shadcn/ui (https://ui.shadcn.com/docs/components/toast)
import { useToast as useToastOriginal } from "@/components/ui/toast"

export { useToast } from "@/components/ui/toast"

export type ToastProps = React.ComponentPropsWithoutRef<typeof Toast>

export interface ToastActionElement {
  altText?: string
  action?: React.ReactNode
  cancel?: React.ReactNode
}

export type ToastVariant = "default" | "destructive" 