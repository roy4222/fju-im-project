'use server'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { signOut } from '@/composition/accounts'

/** 登出。 */
export async function signOutAction() {
  await signOut(await headers())
  redirect('/login')
}
