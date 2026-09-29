import { jest } from '@jest/globals';

/** A mock async function (typed loosely: these stand in for Nest services) */
const asyncFn = () => jest.fn<(...args: unknown[]) => Promise<unknown>>();
import { NotFoundException } from '@nestjs/common';
import { AiContextService } from './ai-context.service';
import type { EventsService } from '../events/events.service';
import type { UsersService } from '../users/users.service';

// The privacy rules of the assistant's context, against stand-ins for EventsService/UsersService.

const EVENT = {
  id: 'event-1',
  name: 'Office Santa',
  description: 'secret office notes',
  eventDate: '2026-12-25',
  budgetMin: 1000,
  budgetMax: 3000,
  currency: 'KGS',
  maxParticipants: 10,
  status: 'drawn',
  inviteCode: 'invite-code-secret',
  drawnAt: new Date(),
  createdAt: new Date(),
  isOwner: true,
  ownerName: 'Owner',
  participantCount: 5,
  readyCount: 5,
  revealed: true,
};

const MATCH = {
  event: EVENT,
  revealedAt: new Date(),
  recipient: {
    name: 'Daniel',
    avatarUrl: 'https://img.example.com/daniel.png',
    interests: ['Football'],
    wishlist: [
      {
        id: 'item-1',
        title: 'Scarf',
        priceApprox: 1500,
        url: 'https://shop.example.com/1',
        position: 0,
        createdAt: new Date(),
      },
    ],
  },
};

const ME = {
  id: 'user-1',
  email: 'me@example.com',
  name: 'Aigerim',
  passwordHash: 'hash-must-never-leak',
  googleId: 'google-must-never-leak',
  avatarUrl: null,
  interests: ['Tea'],
  themePreference: 'system',
  notifyEmail: true,
  notifyReminders: true,
  notifyInvites: true,
  createdAt: new Date(),
};

function setup(event: Partial<typeof EVENT> = {}, match = MATCH) {
  const events = {
    get: asyncFn().mockResolvedValue({ ...EVENT, ...event }),
    myMatch: asyncFn().mockResolvedValue(match),
  };
  const users = { findById: asyncFn().mockResolvedValue(ME) };
  const service = new AiContextService(
    events as unknown as EventsService,
    users as unknown as UsersService,
  );
  return { service, events, users };
}

describe('AiContextService', () => {
  it('builds the context from my own match only, without reveal side effects', async () => {
    const { service, events } = setup();
    const result = await service.forEvent('user-1', 'event-1');

    expect(events.get).toHaveBeenCalledWith('user-1', 'event-1');
    // reveal = false: reading the context never opens a match
    expect(events.myMatch).toHaveBeenCalledWith('user-1', 'event-1', false);
    expect(result).toEqual({
      user: { name: 'Aigerim', interests: ['Tea'] },
      event: {
        name: 'Office Santa',
        date: '2026-12-25',
        budgetMin: 1000,
        budgetMax: 3000,
        currency: 'KGS',
        status: 'drawn',
        iAmOrganizer: true,
        participantCount: 5,
        mySecretSanta: 'opened',
      },
      recipient: {
        name: 'Daniel',
        interests: ['Football'],
        wishlist: [
          {
            title: 'Scarf',
            priceApprox: 1500,
            url: 'https://shop.example.com/1',
          },
        ],
      },
    });
  });

  it('never carries emails, credentials, ids, invite codes, descriptions or avatars', async () => {
    const { service } = setup();
    const json = JSON.stringify(await service.forEvent('user-1', 'event-1'));
    for (const secret of [
      'me@example.com',
      'hash-must-never-leak',
      'google-must-never-leak',
      'invite-code-secret',
      'secret office notes',
      'user-1',
      'event-1',
      'item-1',
      'img.example.com',
    ]) {
      expect(json).not.toContain(secret);
    }
  });

  it('holds exactly one recipient — no list of participants or pairs', async () => {
    const { service } = setup();
    const result = await service.forEvent('user-1', 'event-1');
    expect(Object.keys(result).sort()).toEqual(['event', 'recipient', 'user']);
    expect(Array.isArray(result.recipient)).toBe(false);
  });

  it('gives the event but no recipient until I open my match', async () => {
    const { service, events } = setup({ revealed: false });
    const result = await service.forEvent('user-1', 'event-1');
    expect(result.recipient).toBeNull();
    expect(result.event).toMatchObject({
      name: 'Office Santa',
      mySecretSanta: 'not_opened',
    });
    // Not even read: no name, interests or wishlist can reach the model
    expect(events.myMatch).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('Daniel');
  });

  it('gives the event but no recipient before the draw', async () => {
    const { service, events } = setup({ status: 'open', revealed: false });
    const result = await service.forEvent('user-1', 'event-1');
    expect(result.recipient).toBeNull();
    expect(result.event).toMatchObject({
      status: 'open',
      mySecretSanta: 'not_drawn',
    });
    expect(events.myMatch).not.toHaveBeenCalled();
  });

  it('is not found for events I am not in', async () => {
    const { service, events } = setup();
    events.get.mockRejectedValue(new NotFoundException('Event not found'));
    await expect(service.forEvent('user-1', 'event-2')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(events.myMatch).not.toHaveBeenCalled();
  });

  it('knows only me in a general conversation — no events, no matches', async () => {
    const { service, events } = setup();
    await expect(service.forUser('user-1')).resolves.toEqual({
      user: { name: 'Aigerim', interests: ['Tea'] },
      event: null,
      recipient: null,
    });
    expect(events.get).not.toHaveBeenCalled();
    expect(events.myMatch).not.toHaveBeenCalled();
  });
});
