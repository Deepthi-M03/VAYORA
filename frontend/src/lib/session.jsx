import { createContext, useContext, useEffect, useState } from 'react'
import { DEMO, clearTokens, get, hasSession } from '../api/client.js'

export const SessionCtx = createContext(null)
export const useSession = () => useContext(SessionCtx)

/* The vehicle the rider last chose drives every page transition in the rider app. */
let chosen = 'auto'
export const getChosenVehicle = () => chosen
export const setChosenVehicle = (v) => { chosen = v }

export function SessionProvider({ children }) {
  const [user, setUser] = useState(null)
  const [ready, setReady] = useState(false)
  useEffect(() => {
    if (!hasSession()) { setReady(true); return }
    get('/auth/me').then(setUser).catch(() => clearTokens()).finally(() => setReady(true))
  }, [])
  const logout = () => { clearTokens(); setUser(null) }
  return <SessionCtx.Provider value={{ user, setUser, logout, ready, demo: DEMO }}>{children}</SessionCtx.Provider>
}

export const homeFor = (u) => !u ? '/' : u.role === 'admin' ? '/admin' : u.role === 'driver' ? '/driver' : '/book'
