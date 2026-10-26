// @vitest-environment jsdom
// The assembled browser composition opens Agent Mail without a native code.
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, it } from 'vitest'
import { installAssembledBootEnv, mountAssembledApp } from './assembled-boot.ts'

installAssembledBootEnv()

it('authorizes the local Agent Mail tab silently and exposes the queue surfaces', async () => {
  mountAssembledApp()
  const tree = await screen.findByRole('tree', { name: 'Sessions' })
  const group = (await within(tree).findAllByText('fixture'))
    .map(el => el.closest<HTMLElement>('[role="treeitem"]'))
    .find(el => el?.getAttribute('aria-expanded') !== null)
  if (!group) throw new Error('fixture workspace missing')
  if (group.getAttribute('aria-expanded') === 'false') fireEvent.click(within(group).getByText('fixture'))
  fireEvent.click(await within(tree).findByText('Fixture 历史会话'))

  fireEvent.click(await screen.findByRole('tab', { name: 'Agent Mail' }))
  await waitFor(() => {
    expect(screen.getByText('Workspace inbox')).toBeTruthy()
  })
  expect(screen.getByText('Cross-workspace inbox')).toBeTruthy()
  expect(screen.getByText('Send')).toBeTruthy()
  expect(screen.queryByText('Native authorization code')).toBeNull()
  expect(screen.queryByRole('button', { name: 'Request native code' })).toBeNull()
})
