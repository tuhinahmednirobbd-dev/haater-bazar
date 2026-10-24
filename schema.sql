-- ShopBD database schema (PostgreSQL 15+)
-- Run: psql -U postgres -d shopbd -f schema.sql

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";   -- fast fuzzy search

-- ============ USERS & AUTH ============
CREATE TYPE user_role AS ENUM ('customer', 'seller', 'admin');

CREATE TABLE users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name           VARCHAR(120) NOT NULL,
  email          VARCHAR(255) UNIQUE,
  phone          VARCHAR(20)  UNIQUE,                -- +8801XXXXXXXXX
  password_hash  TEXT,                               -- NULL for social-only accounts
  role           user_role NOT NULL DEFAULT 'customer',
  avatar_url     TEXT,
  email_verified BOOLEAN NOT NULL DEFAULT FALSE,
  phone_verified BOOLEAN NOT NULL DEFAULT FALSE,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT email_or_phone CHECK (email IS NOT NULL OR phone IS NOT NULL)
);

CREATE TABLE social_accounts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider    VARCHAR(20) NOT NULL,                  -- google | facebook
  provider_id VARCHAR(255) NOT NULL,
  UNIQUE (provider, provider_id)
);

CREATE TABLE refresh_tokens (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked    BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_refresh_user ON refresh_tokens(user_id);

CREATE TABLE otp_codes (                              -- phone/email login & verification
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  target     VARCHAR(255) NOT NULL,                   -- phone or email
  code_hash  TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  attempts   INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_otp_target ON otp_codes(target);

CREATE TABLE addresses (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label       VARCHAR(30) DEFAULT 'Home',             -- Home / Office
  full_name   VARCHAR(120) NOT NULL,
  phone       VARCHAR(20) NOT NULL,
  division    VARCHAR(60) NOT NULL,
  district    VARCHAR(60) NOT NULL,
  upazila     VARCHAR(60),
  address     TEXT NOT NULL,
  postal_code VARCHAR(10),
  is_default  BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX idx_addresses_user ON addresses(user_id);

-- ============ CATALOG ============
CREATE TABLE categories (
  id        SERIAL PRIMARY KEY,
  parent_id INT REFERENCES categories(id) ON DELETE SET NULL,   -- sub-categories
  name      VARCHAR(120) NOT NULL,
  slug      VARCHAR(140) NOT NULL UNIQUE,
  image_url TEXT,
  sort_order INT NOT NULL DEFAULT 0
);
CREATE INDEX idx_categories_parent ON categories(parent_id);

CREATE TABLE brands (
  id   SERIAL PRIMARY KEY,
  name VARCHAR(120) NOT NULL UNIQUE,
  slug VARCHAR(140) NOT NULL UNIQUE,
  logo_url TEXT
);

CREATE TABLE products (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id     UUID REFERENCES users(id),
  category_id   INT NOT NULL REFERENCES categories(id),
  brand_id      INT REFERENCES brands(id),
  title         VARCHAR(255) NOT NULL,
  slug          VARCHAR(280) NOT NULL UNIQUE,
  description   TEXT,
  price         NUMERIC(12,2) NOT NULL CHECK (price >= 0),        -- BDT
  discount_price NUMERIC(12,2) CHECK (discount_price >= 0),
  stock         INT NOT NULL DEFAULT 0 CHECK (stock >= 0),
  sku           VARCHAR(80) UNIQUE,
  rating_avg    NUMERIC(2,1) NOT NULL DEFAULT 0,
  rating_count  INT NOT NULL DEFAULT 0,
  sold_count    INT NOT NULL DEFAULT 0,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_products_category ON products(category_id);
CREATE INDEX idx_products_brand    ON products(brand_id);
CREATE INDEX idx_products_price    ON products(price);
CREATE INDEX idx_products_rating   ON products(rating_avg DESC);
CREATE INDEX idx_products_title_trgm ON products USING gin (title gin_trgm_ops);

CREATE TABLE product_images (
  id         SERIAL PRIMARY KEY,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  url        TEXT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0
);
CREATE INDEX idx_product_images_product ON product_images(product_id);

CREATE TABLE product_variants (                        -- size / color etc.
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  name       VARCHAR(120) NOT NULL,                    -- "Red / XL"
  price      NUMERIC(12,2),
  stock      INT NOT NULL DEFAULT 0 CHECK (stock >= 0),
  sku        VARCHAR(80) UNIQUE
);

CREATE TABLE reviews (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id  UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating      SMALLINT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (product_id, user_id)
);

-- ============ CART & WISHLIST ============
CREATE TABLE cart_items (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id UUID REFERENCES product_variants(id) ON DELETE CASCADE,
  quantity   INT NOT NULL DEFAULT 1 CHECK (quantity > 0),
  saved_for_later BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, product_id, variant_id)
);

CREATE TABLE wishlist_items (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, product_id)
);

-- ============ ORDERS & PAYMENTS ============
CREATE TYPE order_status AS ENUM
  ('pending','confirmed','packed','shipped','delivered','cancelled','returned');
CREATE TYPE payment_method AS ENUM ('cod','bkash','nagad','card');
CREATE TYPE payment_status AS ENUM ('unpaid','pending','paid','failed','refunded');

CREATE TABLE coupons (
  id          SERIAL PRIMARY KEY,
  code        VARCHAR(40) NOT NULL UNIQUE,
  percent_off INT CHECK (percent_off BETWEEN 1 AND 100),
  amount_off  NUMERIC(12,2),
  min_order   NUMERIC(12,2) DEFAULT 0,
  expires_at  TIMESTAMPTZ,
  usage_limit INT,
  used_count  INT NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE SEQUENCE order_seq START 1;

CREATE TABLE orders (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_number     VARCHAR(20) NOT NULL UNIQUE,         -- e.g. SB-20261024-0001
  user_id          UUID NOT NULL REFERENCES users(id),
  address_snapshot JSONB NOT NULL,                      -- copy of address at order time
  subtotal         NUMERIC(12,2) NOT NULL,
  shipping_fee     NUMERIC(12,2) NOT NULL DEFAULT 0,
  discount         NUMERIC(12,2) NOT NULL DEFAULT 0,
  total            NUMERIC(12,2) NOT NULL,
  coupon_id        INT REFERENCES coupons(id),
  status           order_status NOT NULL DEFAULT 'pending',
  payment_method   payment_method NOT NULL,
  payment_status   payment_status NOT NULL DEFAULT 'unpaid',
  tracking_number  VARCHAR(80),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_orders_user    ON orders(user_id, created_at DESC);
CREATE INDEX idx_orders_status  ON orders(status);

CREATE TABLE order_items (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id  UUID NOT NULL REFERENCES products(id),
  variant_id  UUID REFERENCES product_variants(id),
  title       VARCHAR(255) NOT NULL,                    -- snapshot
  unit_price  NUMERIC(12,2) NOT NULL,
  quantity    INT NOT NULL CHECK (quantity > 0)
);
CREATE INDEX idx_order_items_order ON order_items(order_id);

CREATE TABLE order_status_history (
  id         SERIAL PRIMARY KEY,
  order_id   UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status     order_status NOT NULL,
  note       TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE payments (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  method        payment_method NOT NULL,
  amount        NUMERIC(12,2) NOT NULL,
  status        payment_status NOT NULL DEFAULT 'pending',
  gateway_txn_id VARCHAR(120),                          -- bKash trxID / SSLCommerz tran_id
  gateway_payload JSONB,                                -- raw verified response
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (gateway_txn_id)
);

-- ============ ADMIN / AUDIT ============
CREATE TABLE audit_logs (
  id         BIGSERIAL PRIMARY KEY,
  user_id    UUID REFERENCES users(id),
  action     VARCHAR(80) NOT NULL,
  entity     VARCHAR(60),
  entity_id  TEXT,
  meta       JSONB,
  ip         INET,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Sales analytics view used by the admin dashboard
CREATE VIEW daily_sales AS
SELECT date_trunc('day', created_at)::date AS day,
       COUNT(*)                             AS orders,
       SUM(total)                           AS revenue
FROM orders
WHERE status NOT IN ('cancelled','returned') AND payment_status IN ('paid','unpaid')
GROUP BY 1;

-- Seed data
INSERT INTO categories (name, slug) VALUES
  ('Electronics','electronics'), ('Fashion','fashion'),
  ('Home & Living','home-living'), ('Groceries','groceries');
INSERT INTO categories (parent_id, name, slug) VALUES
  (1,'Mobile Phones','mobile-phones'), (1,'Laptops','laptops'),
  (2,'Men','men-fashion'), (2,'Women','women-fashion');
INSERT INTO brands (name, slug) VALUES ('Samsung','samsung'),('Xiaomi','xiaomi'),('Walton','walton');
