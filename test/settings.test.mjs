import { mergeSettings, normalizeSettings } from '../lib/settings.mjs'

const cases = []
const check = (name, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected)
  cases.push({ name, ok, actual, expected })
}

// 1. colours follow the skin after a switch is flipped off and on again
const fresh = normalizeSettings(undefined)
check('fresh fold colour = auto', fresh.sidebarFold.color.mode, 'auto')

const off1 = mergeSettings(fresh, { sidebarFold: { enabled: false } })
check('flip off keeps mode auto', off1.sidebarFold.color.mode, 'auto')
check('flip off keeps hexes', off1.sidebarFold.color, fresh.sidebarFold.color)
check('flip off applies', off1.sidebarFold.enabled, false)

const on1 = mergeSettings(off1, { sidebarFold: { enabled: true } })
check('flip back on still auto', on1.sidebarFold.color.mode, 'auto')

// 2. a custom colour survives a switch flip (must not snap back to auto)
const custom = mergeSettings(on1, { sidebarFold: { color: { mode: 'custom', off: '#123456', on: '#654321' } } })
check('custom applied', custom.sidebarFold.color, { mode: 'custom', off: '#123456', on: '#654321' })
const customOff = mergeSettings(custom, { sidebarFold: { enabled: false } })
check('custom survives flip', customOff.sidebarFold.color, { mode: 'custom', off: '#123456', on: '#654321' })

// 3. touching only the colour must not re-enable a disabled feature
const afterColourOnly = mergeSettings(customOff, { sidebarFold: { color: { mode: 'auto' } } })
check('colour-only patch keeps enabled=false', afterColourOnly.sidebarFold.enabled, false)
check('colour-only patch keeps hexes', afterColourOnly.sidebarFold.color, { mode: 'auto', off: '#123456', on: '#654321' })

// 4. the pin keeps the same discipline
const pin = normalizeSettings(undefined)
check('fresh pin = auto', pin.pinTop.color, { mode: 'auto', value: '' })
const pinOff = mergeSettings(pin, { pinTop: { enabled: false } })
check('pin flip keeps auto', pinOff.pinTop.color, { mode: 'auto', value: '' })
const pinCustom = mergeSettings(pin, { pinTop: { color: { mode: 'custom', value: '#abcdef' } } })
check('pin custom applied', pinCustom.pinTop.color, { mode: 'custom', value: '#abcdef' })
check('pin custom keeps enabled', pinCustom.pinTop.enabled, true)

// 5. unknown / garbage input never throws
check('garbage patch tolerated', mergeSettings(fresh, { sidebarFold: 'nope' }).sidebarFold.color.mode, 'auto')
check('null patch tolerated', mergeSettings(fresh, null).sidebarFold.color.mode, 'auto')

const failed = cases.filter((entry) => !entry.ok)
for (const entry of cases) {
  console.log((entry.ok ? 'PASS  ' : 'FAIL  ') + entry.name)
  if (!entry.ok) console.log('      got ' + JSON.stringify(entry.actual) + ' want ' + JSON.stringify(entry.expected))
}
console.log('\n' + (cases.length - failed.length) + '/' + cases.length + ' passed')
if (failed.length > 0) process.exitCode = 1
