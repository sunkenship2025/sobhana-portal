-- Which tests an offer's codes discount. Existing offers keep discounting every test.
CREATE TYPE "CouponTests" AS ENUM ('ALL', 'LISTED', 'ABNORMAL_ON_VISIT', 'STILL_ABNORMAL');

ALTER TABLE "CouponCampaign"
  ADD COLUMN "forTests" "CouponTests" NOT NULL DEFAULT 'ALL',
  ADD COLUMN "testProductIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
