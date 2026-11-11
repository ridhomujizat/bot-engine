import { request, setToken } from './http'

interface LoginResponse {
  status: string
  message: string
  payload: { jwt: string; exp?: number }
}

export async function login(email: string, password: string): Promise<void> {
  const res = await request<LoginResponse>('/api/v1/auth/login/basic/default', {
    method: 'POST',
    body: { email, password },
  })
  setToken(res.payload.jwt)
}

export function logout(): void {
  setToken(null)
}
