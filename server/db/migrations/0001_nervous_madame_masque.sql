CREATE TABLE `loans` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`lender_id` integer NOT NULL,
	`borrower_id` integer NOT NULL,
	`amount` real NOT NULL,
	`lent_at_min` integer NOT NULL,
	`due_at_min` integer NOT NULL,
	`status` text NOT NULL,
	`settled_at_min` integer,
	FOREIGN KEY (`lender_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`borrower_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_loans_borrower` ON `loans` (`borrower_id`);--> statement-breakpoint
CREATE INDEX `idx_loans_lender` ON `loans` (`lender_id`);