import { z } from 'zod';
import { authRoleSchema } from './auth.js';

export const createUserSchema = z.object({
  username: z.string().trim().min(3).max(32).regex(/^[A-Za-z0-9._-]+$/),
  nickname: z.string().trim().min(1).max(20),
  initialPassword: z.string().min(8).max(128),
  role: authRoleSchema,
  rakeEnabled: z.boolean().default(true)
});

export const updateUserSchema = z.object({
  nickname: z.string().trim().min(1).max(20).optional(),
  role: authRoleSchema.optional(),
  rakeEnabled: z.boolean().optional(),
  isActive: z.boolean().optional()
}).refine((value) => Object.keys(value).length > 0);

export const resetUserPasswordSchema = z.object({
  newPassword: z.string().min(8).max(128)
});

export const userResponseSchema = z.object({
  id: z.string(),
  username: z.string(),
  nickname: z.string(),
  role: authRoleSchema,
  rakeEnabled: z.boolean(),
  avatarKind: z.enum(['PRESET', 'UPLOAD']),
  avatarValue: z.string(),
  isActive: z.boolean(),
  mustChangePassword: z.boolean(),
  deletedAt: z.coerce.date().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date()
});

export type CreateUserRequest = z.infer<typeof createUserSchema>;
export type UpdateUserRequest = z.infer<typeof updateUserSchema>;
export type ResetUserPasswordRequest = z.infer<typeof resetUserPasswordSchema>;
export type UserResponse = z.infer<typeof userResponseSchema>;
