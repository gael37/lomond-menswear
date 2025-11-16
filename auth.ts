
import { compareSync } from 'bcrypt-ts-edge';
import type { NextAuthConfig } from 'next-auth';
import NextAuth from 'next-auth';
import CredentialsProvider from 'next-auth/providers/credentials';

import { prisma } from '@/db/prisma';
import { PrismaAdapter } from '@auth/prisma-adapter';


export const config = {

  pages: {
    signIn: '/sign-in',
    error: '/sign-in',
  },

  session: {
  strategy: 'jwt',
  maxAge: 30 * 24 * 60 * 60, // 30 days
},

adapter: PrismaAdapter(prisma),


providers: [
  CredentialsProvider({
    credentials: {
      email: {
        type: 'email',
      },
      password: { type: 'password' },
    },
    async authorize(credentials) {
      if (credentials == null) return null

      // Find user in database
      const user = await prisma.user.findFirst({
        where: {
          email: credentials.email as string,
        },
      })
      // Check if user exists and password is correct
      if (user && user.password) {
        const isMatch = compareSync(
          credentials.password as string,
          user.password
        )
        // If password is correct, return user object
        if (isMatch) {
          return {
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role,
          }
        }
      }
      // If user doesn't exist or password is incorrect, return null
      return null
    },
  }),
],


callbacks: {
    async session({ session, user, trigger, token }: any) {
      session.user.id = token.sub
      if (trigger === 'update') {
        session.user.name = user.name
      }
      return session
    },
  },

} satisfies NextAuthConfig;


export const { handlers, auth, signIn, signOut } = NextAuth(config);
