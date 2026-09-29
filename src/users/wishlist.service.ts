import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { MAX_WISHLIST_ITEMS, type WishlistItemDto } from './dto/profile.dto';

export interface WishlistItem {
  id: string;
  title: string;
  priceApprox: number | null;
  url: string | null;
  position: number;
  createdAt: Date;
}

const ITEM_COLUMNS = `
  id,
  title,
  price_approx as "priceApprox",
  url,
  position,
  created_at   as "createdAt"
`;

/** One wishlist per user; every query is scoped by user_id, so nobody touches another's list */
@Injectable()
export class WishlistService {
  constructor(private readonly db: DatabaseService) {}

  list(userId: string) {
    return this.db.query<WishlistItem>(
      `select ${ITEM_COLUMNS} from wishlist_items
       where user_id = $1
       order by position, created_at`,
      [userId],
    );
  }

  async add(userId: string, dto: WishlistItemDto): Promise<WishlistItem> {
    const [{ count }] = await this.db.query<{ count: number }>(
      `select count(*)::int as count from wishlist_items where user_id = $1`,
      [userId],
    );
    if (count >= MAX_WISHLIST_ITEMS) {
      throw new BadRequestException(
        `A wishlist holds up to ${MAX_WISHLIST_ITEMS} gifts`,
      );
    }

    // New gifts go to the end of the list
    const item = await this.db.one<WishlistItem>(
      `insert into wishlist_items (user_id, title, price_approx, url, position)
       values ($1, $2, $3, $4,
         (select coalesce(max(position), -1) + 1 from wishlist_items where user_id = $1))
       returning ${ITEM_COLUMNS}`,
      [userId, dto.title, dto.priceApprox ?? null, dto.url ?? null],
    );
    return item!;
  }

  async update(
    userId: string,
    itemId: string,
    dto: WishlistItemDto,
  ): Promise<WishlistItem> {
    const item = await this.db.one<WishlistItem>(
      `update wishlist_items
       set title = $3, price_approx = $4, url = $5
       where id = $1 and user_id = $2
       returning ${ITEM_COLUMNS}`,
      [itemId, userId, dto.title, dto.priceApprox ?? null, dto.url ?? null],
    );
    if (!item) throw new NotFoundException('Gift not found');
    return item;
  }

  async remove(userId: string, itemId: string) {
    const deleted = await this.db.query(
      `delete from wishlist_items where id = $1 and user_id = $2 returning id`,
      [itemId, userId],
    );
    if (deleted.length === 0) throw new NotFoundException('Gift not found');
  }
}
