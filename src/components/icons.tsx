/**
 * Local Material Design icons.
 *
 * `@mui/icons-material` is deliberately NOT used: the host shares only the
 * five singletons (react, react-dom, @mui/material, @emotion/react,
 * @emotion/styled), and each icon module imports @mui/material internals by
 * subpath, which drags a second copy of MUI into this remote's bundle — the
 * SDK's no-shared-payload build gate fails on that. Building the icons from
 * the shared `@mui/material` root export keeps the bundle clean.
 *
 * Path data is the standard 24x24 Material Design set (Apache-2.0), identical
 * to what @mui/icons-material ships.
 */
import type { FC, ReactElement } from 'react'

import { SvgIcon, SvgIconProps } from '@mui/material'

const makeIcon = (name: string, d: string): FC<SvgIconProps> => {
  const Icon = (props: SvgIconProps): ReactElement => (
    <SvgIcon {...props}>
      <path d={d} />
    </SvgIcon>
  )
  Icon.displayName = name
  return Icon
}

export const AddIcon = makeIcon('AddIcon', 'M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6v2z')

export const CheckIcon = makeIcon(
  'CheckIcon',
  'M9 16.17 4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z',
)

export const DeleteIcon = makeIcon(
  'DeleteIcon',
  'M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z',
)

export const ExpandLessIcon = makeIcon(
  'ExpandLessIcon',
  'm12 8-6 6 1.41 1.41L12 10.83l4.59 4.58L18 14z',
)

export const FileDownloadIcon = makeIcon(
  'FileDownloadIcon',
  'M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z',
)

export const InfoIcon = makeIcon(
  'InfoIcon',
  'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z',
)

export const MoreVertIcon = makeIcon(
  'MoreVertIcon',
  'M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z',
)

export const PaletteIcon = makeIcon(
  'PaletteIcon',
  'M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-.99 0-.83.67-1.5 1.5-1.5H16c2.76 0 5-2.24 5-5 0-4.42-4.03-8-9-8zm-5.5 9c-.83 0-1.5-.67-1.5-1.5S5.67 9 6.5 9 8 9.67 8 10.5 7.33 12 6.5 12zm3-4C8.67 8 8 7.33 8 6.5S8.67 5 9.5 5s1.5.67 1.5 1.5S10.33 8 9.5 8zm5 0c-.83 0-1.5-.67-1.5-1.5S13.67 5 14.5 5s1.5.67 1.5 1.5S15.33 8 14.5 8zm3 4c-.83 0-1.5-.67-1.5-1.5S16.67 9 17.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z',
)
