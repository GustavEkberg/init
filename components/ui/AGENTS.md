# UI Components

Components installed from external registries, styled for this project.

**Note:** This project uses **Base UI** (`@base-ui/react`) primitives instead of Radix UI with shadcn.

## COMPONENT INVENTORY

### Core (Base UI primitives)

| Component     | File                 | Description                                           |
| ------------- | -------------------- | ----------------------------------------------------- |
| Button        | `button.tsx`         | CVA variants (default/outline/ghost/etc), sizes       |
| Input         | `input.tsx`          | Text input, Base UI primitive                         |
| Textarea      | `textarea.tsx`       | Auto-resize via `field-sizing-content`                |
| Label         | `label.tsx`          | Form label with disabled state                        |
| Select        | `select.tsx`         | Full select (trigger, content, items, groups)         |
| Combobox      | `combobox.tsx`       | Autocomplete with search, chips, multi-select         |
| Dialog        | `dialog.tsx`         | Modal dialog with overlay, portal, animations         |
| AlertDialog   | `alert-dialog.tsx`   | Confirmation dialog with action/cancel                |
| ConfirmDialog | `confirm-dialog.tsx` | Reusable confirm wrapping AlertDialog + pending state |
| DropdownMenu  | `dropdown-menu.tsx`  | Menu with items, checkbox/radio, sub-menus            |
| Popover       | `popover.tsx`        | Positioned popup (side/align)                         |
| HoverCard     | `hover-card.tsx`     | Hover-triggered preview card                          |
| Separator     | `separator.tsx`      | Horizontal/vertical divider                           |

### Display

| Component      | File                   | Description                                      |
| -------------- | ---------------------- | ------------------------------------------------ |
| Badge          | `badge.tsx`            | Inline status badge with variants                |
| Table          | `table.tsx`            | Data table (header, body, row, cell, caption)    |
| Card           | `card.tsx`             | Container with header/title/content/footer       |
| Calendar       | `calendar.tsx`         | `react-day-picker` with range/single/locale      |
| DatePicker     | `date-picker.tsx`      | Popover + Calendar, optional locale              |
| DateTimePicker | `date-time-picker.tsx` | Popover + Calendar + time input, optional locale |

### Form

| Component    | File                | Description                                   |
| ------------ | ------------------- | --------------------------------------------- |
| Field        | `field.tsx`         | Form field layout (FieldSet, FieldGroup, etc) |
| InputGroup   | `input-group.tsx`   | Input with addons (icons, buttons, text)      |
| InputOTP     | `input-otp.tsx`     | OTP code input with slot-based digits         |
| MentionInput | `mention-input.tsx` | Textarea with @mention autocomplete           |

### File

| Component        | File                     | Description                                  |
| ---------------- | ------------------------ | -------------------------------------------- |
| FileLink         | `file-link.tsx`          | Fetches signed URL before opening file       |
| ImagePreviewLink | `image-preview-link.tsx` | Image link with hover preview via signed URL |

## CRITICAL: SelectValue Label Resolution

Base UI's `SelectValue` does **NOT** auto-resolve display labels from `SelectItem` children. Without explicit handling, it renders the raw `value` string (often a UUID).

**ALWAYS** pass a children render function to `SelectValue`:

```tsx
// UUID values — look up label from data array
<SelectValue placeholder="Select phase">
  {(v: string | null) => {
    if (!v) return 'Select phase';
    return phases.find(p => p.id === v)?.name ?? 'Select phase';
  }}
</SelectValue>

// Enum values — use a label map when display differs from value
<SelectValue placeholder="All statuses">
  {(v: string | null) => {
    const labels: Record<string, string> = {
      all: 'All statuses',
      in_progress: 'In Progress',
      completed: 'Completed'
    };
    return labels[v ?? 'all'] ?? 'All statuses';
  }}
</SelectValue>
```

See `member-select.tsx` for the canonical reusable component example.

**Never** use a bare `<SelectValue placeholder="..." />` — it will show IDs.

## INSTALL SOURCES

### shadcn/ui

Standard UI components (buttons, inputs, dialogs, etc.)

```bash
pnpm dlx shadcn@latest add [component]
```

Browse components: https://ui.shadcn.com/docs/components

### shadcn blocks

Pre-built page sections (hero, pricing, features, etc.)

```bash
pnpm dlx shadcn@latest add @shadcnblocks/[block-name]
```

Requires `SHADCNBLOCKS_API_KEY` env var for pro blocks.

Browse blocks: https://shadcnblocks.com

### React Bits

Animated, interactive components (text animations, backgrounds, effects)

```bash
pnpm dlx shadcn@latest add "@react-bits/[ComponentName]-TS-TW"
```

Format: `@react-bits/[ComponentName]-TS-TW` (TypeScript + Tailwind)

Browse components: https://reactbits.dev
