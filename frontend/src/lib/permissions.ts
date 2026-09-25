// Mirror of backend/tavern/permissions.py. Keep the bit values in sync.
import type { Channel, Member, Overwrite, Role, Server } from '../store/types';
import { ChannelType } from '../store/types';

export const P = {
  VIEW_CHANNEL: 1 << 0,
  SEND_MESSAGES: 1 << 1,
  READ_MESSAGE_HISTORY: 1 << 2,
  EMBED_LINKS: 1 << 3,
  ATTACH_FILES: 1 << 4,
  ADD_REACTIONS: 1 << 5,
  MENTION_EVERYONE: 1 << 6,
  USE_CHARACTERS: 1 << 7,
  PIN_MESSAGES: 1 << 8,
  MANAGE_MESSAGES: 1 << 9,
  CREATE_INVITE: 1 << 10,
  MANAGE_CHANNELS: 1 << 11,
  MANAGE_ROLES: 1 << 12,
  MANAGE_EMOJIS: 1 << 13,
  KICK_MEMBERS: 1 << 14,
  BAN_MEMBERS: 1 << 15,
  MANAGE_SERVER: 1 << 16,
  CONNECT: 1 << 17,
  SPEAK: 1 << 18,
  STREAM: 1 << 19,
  MUTE_MEMBERS: 1 << 20,
  DEAFEN_MEMBERS: 1 << 21,
  MOVE_MEMBERS: 1 << 22,
  DJ: 1 << 23,
  DUNGEON_MASTER: 1 << 24,
  ADMINISTRATOR: 1 << 30,
} as const;

export const ALL = ((1 << 25) - 1) | P.ADMINISTRATOR;

export const PRIVATE_CHANNEL =
  P.VIEW_CHANNEL |
  P.SEND_MESSAGES |
  P.READ_MESSAGE_HISTORY |
  P.EMBED_LINKS |
  P.ATTACH_FILES |
  P.ADD_REACTIONS |
  P.MENTION_EVERYONE |
  P.USE_CHARACTERS |
  P.PIN_MESSAGES;

export interface PermissionInfo {
  bit: number;
  name: string;
  description: string;
  channel: boolean; // can be overridden per channel
  voice?: boolean; // only meaningful on voice spaces
  text?: boolean; // only meaningful on text channels
}

/** The Admin permission sits on its own above every group. */
export const ADMIN_PERMISSION: PermissionInfo = {
  bit: P.ADMINISTRATOR,
  name: 'Admin',
  description: 'Grants every permission below and bypasses all channel-specific permissions. Only give this to people you trust completely.',
  channel: false,
};

export const PERMISSION_GROUPS: { title: string; perms: PermissionInfo[] }[] = [
  {
    title: 'General Server Permissions',
    perms: [
      { bit: P.VIEW_CHANNEL, name: 'View Channels', description: 'Allows members to view channels by default (excluding private channels).', channel: true },
      { bit: P.MANAGE_CHANNELS, name: 'Manage Channels', description: 'Allows members to create, edit, or delete channels.', channel: true },
      {
        bit: P.MANAGE_ROLES,
        name: 'Manage Roles',
        description: 'Allows members to create new roles and edit or delete roles lower than their highest role. Also lets them change channel permissions.',
        channel: true,
      },
      { bit: P.MANAGE_EMOJIS, name: 'Manage Emoji', description: 'Allows members to add or remove custom emojis in this server.', channel: false },
      {
        bit: P.MANAGE_SERVER,
        name: 'Manage Server',
        description: "Allows members to change this server's name, icon and system messages channel, and see every invite.",
        channel: false,
      },
    ],
  },
  {
    title: 'Membership Permissions',
    perms: [
      { bit: P.CREATE_INVITE, name: 'Create Invite', description: 'Allows members to invite new people to this server.', channel: true },
      { bit: P.KICK_MEMBERS, name: 'Kick Members', description: 'Allows members to remove other members from this server. Kicked members can rejoin with a new invite.', channel: false },
      { bit: P.BAN_MEMBERS, name: 'Ban Members', description: 'Allows members to permanently ban other members from this server.', channel: false },
    ],
  },
  {
    title: 'Text Channel Permissions',
    perms: [
      { bit: P.SEND_MESSAGES, name: 'Send Messages', description: 'Allows members to send messages and roll dice in text channels.', channel: true, text: true },
      { bit: P.EMBED_LINKS, name: 'Embed Links', description: 'Allows links that members share to show embedded content in text channels.', channel: true, text: true },
      { bit: P.ATTACH_FILES, name: 'Attach Files', description: 'Allows members to upload files or media in text channels.', channel: true, text: true },
      { bit: P.ADD_REACTIONS, name: 'Add Reactions', description: 'Allows members to add new emoji reactions to a message.', channel: true, text: true },
      {
        bit: P.MENTION_EVERYONE,
        name: 'Mention @everyone, @here, and All Roles',
        description: 'Allows members to use @everyone and @here, and to @mention roles even if they are not mentionable.',
        channel: true,
        text: true,
      },
      { bit: P.MANAGE_MESSAGES, name: 'Manage Messages', description: 'Allows members to delete messages by other members.', channel: true, text: true },
      { bit: P.PIN_MESSAGES, name: 'Pin Messages', description: 'Allows members to pin or unpin any message.', channel: true, text: true },
      {
        bit: P.READ_MESSAGE_HISTORY,
        name: 'Read Message History',
        description: 'Allows members to read messages sent before they opened the channel.',
        channel: true,
        text: true,
      },
    ],
  },
  {
    title: 'Voice Space Permissions',
    perms: [
      { bit: P.CONNECT, name: 'Connect', description: 'Allows members to join voice spaces and hear others.', channel: true, voice: true },
      { bit: P.SPEAK, name: 'Speak', description: 'Allows members to talk in voice spaces. Without it they join muted.', channel: true, voice: true },
      { bit: P.STREAM, name: 'Video & Screen Share', description: 'Allows members to turn on their camera or share their screen.', channel: true, voice: true },
      { bit: P.MUTE_MEMBERS, name: 'Mute Members', description: 'Allows members to mute other members in voice spaces for everyone.', channel: true, voice: true },
      { bit: P.DEAFEN_MEMBERS, name: 'Deafen Members', description: 'Allows members to deafen other members in voice spaces.', channel: true, voice: true },
      {
        bit: P.MOVE_MEMBERS,
        name: 'Move Members',
        description: 'Allows members to move or disconnect others between voice spaces, and to join full ones.',
        channel: true,
        voice: true,
      },
    ],
  },
  {
    title: 'Roleplay Permissions',
    perms: [
      {
        bit: P.USE_CHARACTERS,
        name: 'Use Characters',
        description: 'Allows members to send messages and roll as their characters. Turn this off in out-of-character channels so everyone speaks as themselves.',
        channel: true,
        text: true,
      },
      {
        bit: P.DUNGEON_MASTER,
        name: 'Dungeon Master',
        description:
          'Lets members roll dice for other players, see private rolls, edit anyone’s character sheet, post as the narrator, and turn DM Lock on or off. While DM Lock is on, only Dungeon Masters control the jukebox.',
        channel: false,
      },
      {
        bit: P.DJ,
        name: 'DJ',
        description:
          'Lets members control the jukebox: play, pause, skip, fade, change its volume, manage the queue and add songs to the library. Everyone can listen and set their own volume without it.',
        channel: false,
      },
    ],
  },
];

export interface PermContext {
  server: Server;
  roles: Record<number, Role>;
  member: Member | undefined;
  channels: Record<number, Channel>;
}

function applyOverwrites(perms: number, overwrites: Overwrite[] | undefined, everyoneId: number, roleIds: number[], userId: number): number {
  if (!overwrites?.length) return perms;
  const everyone = overwrites.find((o) => o.type === 0 && o.id === everyoneId);
  if (everyone) perms = (perms & ~everyone.deny) | everyone.allow;
  let allow = 0;
  let deny = 0;
  for (const o of overwrites) {
    if (o.type === 0 && roleIds.includes(o.id)) {
      allow |= o.allow;
      deny |= o.deny;
    }
  }
  perms = (perms & ~deny) | allow;
  const mine = overwrites.find((o) => o.type === 1 && o.id === userId);
  if (mine) perms = (perms & ~mine.deny) | mine.allow;
  return perms;
}

export function everyoneRole(roles: Record<number, Role>, serverId: number): Role | undefined {
  return Object.values(roles).find((r) => r.server_id === serverId && r.is_default);
}

export function basePermissions(ctx: PermContext, userId: number): number {
  if (!ctx.member) return 0;
  if (ctx.server.owner_id === userId) return ALL;
  const everyone = everyoneRole(ctx.roles, ctx.server.id);
  let perms = everyone?.permissions ?? 0;
  for (const rid of ctx.member.role_ids) perms |= ctx.roles[rid]?.permissions ?? 0;
  if (perms & P.ADMINISTRATOR) return ALL;
  return perms;
}

export function channelPermissions(ctx: PermContext, userId: number, channel: Channel): number {
  if (channel.type === ChannelType.DM || channel.type === ChannelType.GROUP_DM) {
    return channel.recipient_ids?.includes(userId) ? PRIVATE_CHANNEL : 0;
  }
  if (!ctx.member) return 0;
  const base = basePermissions(ctx, userId);
  if (base === ALL) return ALL;
  const everyoneId = everyoneRole(ctx.roles, ctx.server.id)?.id ?? -1;
  const roleIds = ctx.member.role_ids;
  let perms = base;
  if (channel.parent_id) {
    const parent = ctx.channels[channel.parent_id];
    if (parent) perms = applyOverwrites(perms, parent.overwrites, everyoneId, roleIds, userId);
  }
  perms = applyOverwrites(perms, channel.overwrites, everyoneId, roleIds, userId);
  if (!(perms & P.VIEW_CHANNEL)) return 0;
  return perms;
}

export const has = (perms: number, bit: number) => (perms & bit) === bit;

export function highestRolePosition(ctx: PermContext, userId: number): number {
  if (ctx.server.owner_id === userId) return Number.MAX_SAFE_INTEGER;
  return Math.max(0, ...(ctx.member?.role_ids ?? []).map((r) => ctx.roles[r]?.position ?? 0));
}
