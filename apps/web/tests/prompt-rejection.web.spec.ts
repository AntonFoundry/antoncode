// @vitest-environment jsdom
// Real built browser composition and fixture RPC carry a rejected prompt to the composer.
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, it } from 'vitest'
import { installAssembledBootEnv, mountAssembledApp } from './assembled-boot.ts'

installAssembledBootEnv()

it('names the admission failure without claiming that the agent is busy', async () => {
  mountAssembledApp({ remote: { rejectPrompt: true } })
  const tree = await screen.findByRole('tree', { name: 'Sessions' })
  const group = (await within(tree).findAllByText('fixture'))
    .map(el => el.closest<HTMLElement>('[role="treeitem"]'))
    .find(el => el?.getAttribute('aria-expanded') !== null)
  if (!group) throw new Error('fixture workspace missing')
  if (group.getAttribute('aria-expanded') === 'false') fireEvent.click(within(group).getByText('fixture'))
  fireEvent.click(await within(tree).findByText('Fixture 历史会话'))

  const textarea = await screen.findByPlaceholderText('Message the agent')
  fireEvent.change(textarea, { target: { value: 'keep this draft' } })
  fireEvent.keyDown(textarea, { key: 'Enter' })
  const toast = await screen.findByRole('alert')
  expect(toast.textContent).toMatchInlineSnapshot('"Error: session storage temporarily unavailable"')
  await waitFor(() => { expect((textarea as HTMLTextAreaElement).value).toBe('keep this draft') })
})
