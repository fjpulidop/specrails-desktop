import { describe, expect, it } from 'vitest'
import { Route, Routes, useLocation } from 'react-router-dom'
import { render, screen } from '../../test-utils'
import IntegrationsPage from '../IntegrationsPage'

function LocationProbe() {
  const location = useLocation()
  return <div data-testid="location">{location.pathname}</div>
}

describe('IntegrationsPage', () => {
  it('keeps the legacy route as a redirect to Plugins', async () => {
    render(
      <Routes>
        <Route path="/integrations" element={<IntegrationsPage />} />
        <Route path="/plugins" element={<LocationProbe />} />
      </Routes>,
      { route: '/integrations' },
    )

    expect(await screen.findByTestId('location')).toHaveTextContent('/plugins')
  })
})
