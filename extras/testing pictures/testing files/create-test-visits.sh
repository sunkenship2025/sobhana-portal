#!/bin/bash

# Login and get token
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"admin@sobhana.com","password":"admin123"}' | jq -r '.token')

echo "Logged in, token: ${TOKEN:0:20}..."

# Get patient and branch IDs
PATIENT_ID=$(curl -s http://localhost:3000/api/patients \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-branch-id: cmjzumgap00003zwljoqlubsn" | jq -r '.patients[0].id')

echo "Patient ID: $PATIENT_ID"

# Get lab tests
LAB_TESTS=$(curl -s http://localhost:3000/api/lab-tests \
  -H "Authorization: Bearer $TOKEN" \
  -H "x-branch-id: cmjzumgap00003zwljoqlubsn" | jq -r '.labTests[:2] | map(.id)')

echo "Lab test IDs: $LAB_TESTS"

# Create diagnostic visit with tests (MPR)
echo -e "\n1. Creating visit D-MPR-TEST-01 (no results yet)..."
VISIT1=$(curl -s -X POST http://localhost:3000/api/diagnostic-visits \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "x-branch-id: cmjzumgap00003zwljoqlubsn" \
  -d "{
    \"patientId\": \"$PATIENT_ID\",
    \"testOrders\": [
      {\"labTestId\": \"$(echo $LAB_TESTS | jq -r '.[0]')\"},
      {\"labTestId\": \"$(echo $LAB_TESTS | jq -r '.[1]')\"}
    ],
    \"paymentType\": \"CASH\"
  }")

echo "$VISIT1" | jq '.'

# Create diagnostic visit with tests (KPY)
echo -e "\n2. Creating visit D-KPY-TEST-02 (will add draft results)..."
VISIT2=$(curl -s -X POST http://localhost:3000/api/diagnostic-visits \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "x-branch-id: cmjzumgaw00013zwl3tnr4yyn" \
  -d "{
    \"patientId\": \"$PATIENT_ID\",
    \"testOrders\": [
      {\"labTestId\": \"$(echo $LAB_TESTS | jq -r '.[0]')\"},
      {\"labTestId\": \"$(echo $LAB_TESTS | jq -r '.[1]')\"}
    ],
    \"paymentType\": \"CASH\"
  }")

echo "$VISIT2" | jq '.'
VISIT2_ID=$(echo "$VISIT2" | jq -r '.id')

# Add draft results to VISIT2
echo -e "\n3. Adding draft results to D-KPY-TEST-02..."
TEST_ORDER_IDS=$(echo "$VISIT2" | jq -r '.testOrders | map(.id)')
TEST_ORDER_1=$(echo $TEST_ORDER_IDS | jq -r '.[0]')
TEST_ORDER_2=$(echo $TEST_ORDER_IDS | jq -r '.[1]')

curl -s -X POST "http://localhost:3000/api/diagnostic-visits/$VISIT2_ID/report" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "x-branch-id: cmjzumgaw00013zwl3tnr4yyn" \
  -d "{
    \"testResults\": [
      {\"testOrderId\": \"$TEST_ORDER_1\", \"value\": 14.5, \"flag\": \"NORMAL\", \"notes\": \"Within normal range\"},
      {\"testOrderId\": \"$TEST_ORDER_2\", \"value\": 7500, \"flag\": \"NORMAL\", \"notes\": \"Normal count\"}
    ]
  }" | jq '.'

# Create third visit and finalize it (MPR)
echo -e "\n4. Creating visit D-MPR-TEST-03 with finalized report..."
VISIT3=$(curl -s -X POST http://localhost:3000/api/diagnostic-visits \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "x-branch-id: cmjzumgap00003zwljoqlubsn" \
  -d "{
    \"patientId\": \"$PATIENT_ID\",
    \"testOrders\": [
      {\"labTestId\": \"$(echo $LAB_TESTS | jq -r '.[0]')\"},
      {\"labTestId\": \"$(echo $LAB_TESTS | jq -r '.[1]')\"}
    ],
    \"paymentType\": \"CASH\"
  }")

VISIT3_ID=$(echo "$VISIT3" | jq -r '.id')
echo "$VISIT3" | jq '.'

# Add results and finalize
echo -e "\n5. Adding and finalizing report for D-MPR-TEST-03..."
TEST_ORDER_IDS3=$(echo "$VISIT3" | jq -r '.testOrders | map(.id)')
TEST_ORDER_3_1=$(echo $TEST_ORDER_IDS3 | jq -r '.[0]')
TEST_ORDER_3_2=$(echo $TEST_ORDER_IDS3 | jq -r '.[1]')

# Create draft
DRAFT=$(curl -s -X POST "http://localhost:3000/api/diagnostic-visits/$VISIT3_ID/report" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "x-branch-id: cmjzumgap00003zwljoqlubsn" \
  -d "{
    \"testResults\": [
      {\"testOrderId\": \"$TEST_ORDER_3_1\", \"value\": 13.2, \"flag\": \"NORMAL\", \"notes\": \"Normal hemoglobin\"},
      {\"testOrderId\": \"$TEST_ORDER_3_2\", \"value\": 8200, \"flag\": \"NORMAL\", \"notes\": \"WBC count normal\"}
    ]
  }")

VERSION_ID=$(echo "$DRAFT" | jq -r '.version.id')

# Finalize the report
curl -s -X POST "http://localhost:3000/api/diagnostic-visits/$VISIT3_ID/report/finalize" \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "x-branch-id: cmjzumgap00003zwljoqlubsn" \
  -d "{\"versionId\": \"$VERSION_ID\"}" | jq '.'

echo -e "\n✅ Test data created successfully!"
echo "- D-MPR-TEST-01: Waiting for results"
echo "- D-KPY-TEST-02: Has draft results"  
echo "- D-MPR-TEST-03: Finalized report (immutable)"
