'use client'
import { useRouter } from 'next/navigation'
import { Badge } from '@/app/_ui/ui/badge'
import { Button } from '@/app/_ui/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/app/_ui/ui/dropdown-menu'

/**
 * 原型 Data Table 工具列的篩選鈕（「類型」「狀態」「指導老師」…）：白框按鈕，選了條件就多一個小計數。
 *
 * 原型是前端多選；正式碼的篩選在伺服器、每個條件一個值，所以這裡是**單選**，
 * 每個選項就是一個網址（伺服器先算好，帶著其他條件），選了就換頁——資料流跟原本的 GET 表單一樣。
 */
export type FacetOption = { readonly value: string; readonly label: string; readonly href: string }

export function FacetMenu({
  label,
  options,
  value,
  allValue = '',
}: {
  label: string
  options: readonly FacetOption[]
  /** 目前的值；等於 `allValue` 代表沒篩。 */
  value: string
  allValue?: string
}) {
  const router = useRouter()
  const active = value !== allValue
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="outline" size="lg" className="gap-1.5" aria-label={`篩選${label}`}>
            {label}
            {active ? (
              <Badge variant="outline" className="ml-1 text-[10px]">
                {options.find((o) => o.value === value)?.label ?? 1}
              </Badge>
            ) : null}
          </Button>
        }
      />
      <DropdownMenuContent align="start" className="w-52">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{label}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup
            value={value}
            onValueChange={(next) => {
              const hit = options.find((o) => o.value === next)
              if (hit) router.push(hit.href)
            }}
          >
            {options.map((o) => (
              <DropdownMenuRadioItem key={o.value} value={o.value}>
                {o.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
