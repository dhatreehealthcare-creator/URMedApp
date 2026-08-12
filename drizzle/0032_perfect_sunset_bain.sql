CREATE TABLE `inventory_reservations` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` integer NOT NULL,
	`order_item_id` integer NOT NULL,
	`vendor_id` integer NOT NULL,
	`inventory_id` integer NOT NULL,
	`quantity` integer NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`expires_at` text NOT NULL,
	`committed_at` text,
	`committed_by_profile_id` integer,
	`released_at` text,
	`status_reason` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `orders`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`order_item_id`) REFERENCES `order_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`vendor_id`) REFERENCES `vendors`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`inventory_id`) REFERENCES `pharmacy_inventory`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`committed_by_profile_id`) REFERENCES `account_profiles`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `inventory_reservations_order_item_uidx` ON `inventory_reservations` (`order_item_id`);--> statement-breakpoint
CREATE INDEX `inventory_reservations_order_status_idx` ON `inventory_reservations` (`order_id`,`status`);--> statement-breakpoint
CREATE INDEX `inventory_reservations_active_expiry_idx` ON `inventory_reservations` (`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `inventory_reservations_inventory_status_idx` ON `inventory_reservations` (`inventory_id`,`status`);--> statement-breakpoint
ALTER TABLE `orders` ADD `inventory_status` text DEFAULT 'committed' NOT NULL;--> statement-breakpoint
ALTER TABLE `orders` ADD `reservation_expires_at` text;--> statement-breakpoint
CREATE TRIGGER `inventory_reservation_insert_guard`
BEFORE INSERT ON `inventory_reservations`
WHEN NEW.status <> 'active'
	OR NEW.quantity < 1
	OR datetime(NEW.expires_at) <= datetime('now')
	OR NOT EXISTS (
		SELECT 1 FROM orders current_order
		JOIN order_items item ON item.id=NEW.order_item_id AND item.order_id=current_order.id
		JOIN pharmacy_inventory inventory ON inventory.id=NEW.inventory_id
		WHERE current_order.id=NEW.order_id
			AND current_order.vendor_id=NEW.vendor_id
			AND current_order.payment_method='online'
			AND current_order.inventory_status='reserved'
			AND current_order.order_status<>'cancelled'
			AND current_order.reservation_expires_at=NEW.expires_at
			AND item.inventory_id=NEW.inventory_id
			AND item.quantity=NEW.quantity
			AND inventory.vendor_id=NEW.vendor_id
			AND (inventory.quantity-inventory.reserved_quantity)>=NEW.quantity
	)
BEGIN
	SELECT RAISE(ABORT, 'reservation_stock_unavailable');
END;--> statement-breakpoint
CREATE TRIGGER `inventory_reservation_after_insert`
AFTER INSERT ON `inventory_reservations`
WHEN NEW.status='active'
BEGIN
	UPDATE pharmacy_inventory
	SET reserved_quantity=reserved_quantity+NEW.quantity,updated_at=CURRENT_TIMESTAMP
	WHERE id=NEW.inventory_id AND vendor_id=NEW.vendor_id
		AND (quantity-reserved_quantity)>=NEW.quantity;
	SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT, 'reservation_stock_unavailable') END;
END;--> statement-breakpoint
CREATE TRIGGER `inventory_reservation_identity_guard`
BEFORE UPDATE ON `inventory_reservations`
WHEN NEW.order_id<>OLD.order_id
	OR NEW.order_item_id<>OLD.order_item_id
	OR NEW.vendor_id<>OLD.vendor_id
	OR NEW.inventory_id<>OLD.inventory_id
	OR NEW.quantity<>OLD.quantity
BEGIN
	SELECT RAISE(ABORT, 'reservation_identity_immutable');
END;--> statement-breakpoint
CREATE TRIGGER `inventory_reservation_transition_guard`
BEFORE UPDATE OF status ON `inventory_reservations`
WHEN NEW.status<>OLD.status
	AND (OLD.status<>'active' OR NEW.status NOT IN ('committed','released','expired')
		OR (NEW.status IN ('released','expired') AND NEW.released_at IS NULL))
BEGIN
	SELECT RAISE(ABORT, 'reservation_invalid_transition');
END;--> statement-breakpoint
CREATE TRIGGER `inventory_reservation_commit_guard`
BEFORE UPDATE OF status ON `inventory_reservations`
WHEN OLD.status='active' AND NEW.status='committed'
	AND (
		datetime(OLD.expires_at)<=datetime('now')
		OR NEW.committed_at IS NULL
		OR NOT EXISTS (
			SELECT 1 FROM pharmacy_inventory inventory
			WHERE inventory.id=OLD.inventory_id AND inventory.vendor_id=OLD.vendor_id
				AND inventory.quantity>=OLD.quantity AND inventory.reserved_quantity>=OLD.quantity
		)
	)
BEGIN
	SELECT RAISE(ABORT, 'reservation_expired_or_stock_unavailable');
END;--> statement-breakpoint
CREATE TRIGGER `inventory_reservation_after_commit`
AFTER UPDATE OF status ON `inventory_reservations`
WHEN OLD.status='active' AND NEW.status='committed'
BEGIN
	UPDATE pharmacy_inventory
	SET quantity=quantity-OLD.quantity,reserved_quantity=reserved_quantity-OLD.quantity,updated_at=CURRENT_TIMESTAMP
	WHERE id=OLD.inventory_id AND vendor_id=OLD.vendor_id
		AND quantity>=OLD.quantity AND reserved_quantity>=OLD.quantity;
	SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT, 'reservation_stock_unavailable') END;
END;--> statement-breakpoint
CREATE TRIGGER `inventory_reservation_after_release`
AFTER UPDATE OF status ON `inventory_reservations`
WHEN OLD.status='active' AND NEW.status IN ('released','expired')
BEGIN
	UPDATE pharmacy_inventory
	SET reserved_quantity=reserved_quantity-OLD.quantity,updated_at=CURRENT_TIMESTAMP
	WHERE id=OLD.inventory_id AND vendor_id=OLD.vendor_id AND reserved_quantity>=OLD.quantity;
	SELECT CASE WHEN changes()<>1 THEN RAISE(ABORT, 'reservation_release_invalid') END;
END;--> statement-breakpoint
CREATE TRIGGER `order_inventory_commit_guard`
BEFORE UPDATE OF inventory_status ON `orders`
WHEN OLD.inventory_status='reserved' AND NEW.inventory_status='committed'
	AND (
		datetime(OLD.reservation_expires_at)<=datetime('now')
		OR (SELECT COUNT(*) FROM inventory_reservations reservation WHERE reservation.order_id=OLD.id)
			<> (SELECT COUNT(*) FROM order_items item WHERE item.order_id=OLD.id)
		OR EXISTS (SELECT 1 FROM inventory_reservations reservation WHERE reservation.order_id=OLD.id AND reservation.status<>'committed')
	)
BEGIN
	SELECT RAISE(ABORT, 'reservation_commit_incomplete');
END;--> statement-breakpoint
CREATE TRIGGER `order_paid_inventory_guard`
BEFORE UPDATE OF payment_status ON `orders`
WHEN OLD.payment_status<>'paid' AND NEW.payment_status='paid'
	AND OLD.inventory_status='reserved' AND NEW.inventory_status<>'committed'
BEGIN
	SELECT RAISE(ABORT, 'reservation_commit_incomplete');
END;--> statement-breakpoint
PRAGMA optimize;
