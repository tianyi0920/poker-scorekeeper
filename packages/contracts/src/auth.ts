import { z } from 'zod';

export const authRoleSchema = z.enum(['SUPER_ADMIN', 'ADMIN', 'USER']);

export const authUserSchema = z.object({
  id: z.string(),
  username: z.string(),
  nickname: z.string(),
  role: authRoleSchema,
  mustChangePassword: z.boolean()
});

export const loginRequestSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(1024)
});

export const changePasswordRequestSchema = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(1).max(1024)
});

export const authSessionResponseSchema = z.object({
  user: authUserSchema,
  csrfToken: z.string().regex(/^[a-f0-9]{64}$/)
});

export type AuthRole = z.infer<typeof authRoleSchema>;
export type AuthUserContract = z.infer<typeof authUserSchema>;
export type LoginRequest = z.infer<typeof loginRequestSchema>;
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;
export type AuthSessionResponse = z.infer<typeof authSessionResponseSchema>;
