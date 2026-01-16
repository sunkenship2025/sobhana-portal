# 🧪 Cross-Reference Detection Testing Guide

## ✅ Backend API Test Results

The backend API is **working correctly**! Here's what we tested:

### Test Results:
1. **Referral Doctor Lookup (phone: 9876543220)**
   - Found: Dr. Sharma (RD-00001)
   - Commission: 10%
   - Status: ✅ Working

2. **Clinic Doctor Lookup (phone: 9876543231)**
   - Found: Dr. Ravi Kumar (CD-00002)
   - Specialty: Pediatrics
   - Status: ✅ Working

---

## 🎯 How to Test on Frontend

### Step 1: Access the Application
1. Open your browser
2. Navigate to: **http://localhost:8080**
3. You should see the login page

### Step 2: Login
Use these credentials:
- **Email**: `owner@sobhana.com`
- **Password**: `password123`

### Step 3: Test Cross-Reference in Referral Doctors

#### Test Case 1: Detect Existing Clinic Doctor
1. Navigate to **"Manage Referral Doctors"** (Owner menu)
2. Click **"Add Doctor"** button
3. In the phone field, type: `9876543230`
4. **Expected Result**: After typing 10 digits, you should see:
   ```
   ⚠️ Clinic Doctor Found
   Dr. Meera Sharma (CD-00001) - General Medicine
   [Link to this doctor] button
   ```
5. Click **"Link to this doctor"**
6. **Expected Result**: 
   - Name field auto-fills with "Dr. Meera Sharma"
   - Green checkmark appears: "✓ Linked"
   - Toast notification: "Linked to clinic doctor CD-00001"

#### Test Case 2: Detect Another Clinic Doctor
1. Clear the form or start fresh
2. Type phone: `9876543231`
3. **Expected Result**: Alert shows "Dr. Ravi Kumar (CD-00002) - Pediatrics"

#### Test Case 3: New Doctor (No Conflict)
1. Type phone: `9999999999` (any new number)
2. **Expected Result**: No alert appears, form works normally

### Step 4: Test Cross-Reference in Clinic Doctors

#### Test Case 1: Detect Existing Referral Doctor
1. Navigate to **"Manage Clinic Doctors"** (Clinic menu)
2. Click **"Add Doctor"** button
3. In the phone field, type: `9876543220`
4. **Expected Result**: After 10 digits:
   ```
   ⚠️ Referral Doctor Found
   Dr. Sharma (RD-00001) - 10% commission
   [Link to this doctor] button
   ```
5. Click **"Link to this doctor"**
6. **Expected Result**:
   - Name field auto-fills with "Dr. Sharma"
   - Green checkmark: "✓ Linked"
   - Toast: "Linked to referral doctor RD-00001"

#### Test Case 2: Another Referral Doctor
1. Type phone: `9876543221`
2. **Expected Result**: Alert shows "Dr. Mehra (RD-00002) - 12% commission"

---

## 🔍 Debugging Checklist

If you don't see the alerts appearing:

### 1. Check Browser Console
1. Press `F12` or `Cmd+Option+I` (Mac)
2. Go to **Console** tab
3. Look for errors related to:
   - Network requests failing
   - CORS errors
   - Authorization errors

### 2. Check Network Tab
1. In DevTools, go to **Network** tab
2. Type a 10-digit phone number
3. Look for a request to: `http://localhost:3000/api/doctors/search-by-contact?phone=...`
4. Check:
   - **Status**: Should be `200 OK`
   - **Response**: Should contain doctor data
   - **Headers**: Should include `Authorization: Bearer ...`

### 3. Verify Token is Set
1. In Browser Console, type:
   ```javascript
   localStorage.getItem('token')
   ```
2. Should show a JWT token
3. If `null`, you're not logged in properly

### 4. Check Backend Logs
In the terminal running the backend, you should see:
- No errors
- API requests being logged (if logging is enabled)

---

## 📝 Test Data Available

### Referral Doctors:
| Name | Phone | Commission | Doctor Number |
|------|-------|------------|---------------|
| Dr. Sharma | 9876543220 | 10% | RD-00001 |
| Dr. Mehra | 9876543221 | 12% | RD-00002 |

### Clinic Doctors:
| Name | Phone | Specialty | Doctor Number |
|------|-------|-----------|---------------|
| Dr. Meera Sharma | 9876543230 | General Medicine | CD-00001 |
| Dr. Ravi Kumar | 9876543231 | Pediatrics | CD-00002 |

---

## 🐛 Common Issues & Solutions

### Issue 1: No alert appears when typing phone
**Possible Causes:**
- Not logged in (no token)
- Backend not running
- Phone number < 10 digits
- Network request failing

**Solution:**
1. Check if logged in
2. Verify both servers are running:
   - Backend: http://localhost:3000/health (should return `{"status":"ok"}`)
   - Frontend: http://localhost:8080 (should load)
3. Type full 10 digits
4. Check browser console for errors

### Issue 2: CORS Error
**Solution:**
- Backend already has CORS enabled
- If still seeing CORS errors, restart backend:
  ```bash
  cd health-hub-backend
  npm run dev
  ```

### Issue 3: 401 Unauthorized
**Solution:**
- Token expired or invalid
- Logout and login again
- Clear localStorage: `localStorage.clear()` in browser console

### Issue 4: "Link" button doesn't work
**Solution:**
- Check browser console for errors
- Verify state management is working
- Look for toast notifications (bottom right)

---

## 🎬 Video Demo Script

1. **Show Login**: Enter credentials and login
2. **Referral Doctors Page**: Click "Add Doctor"
3. **Type Clinic Doctor Phone**: Show yellow alert appearing
4. **Click Link**: Show name auto-filling and green checkmark
5. **Switch to Clinic Doctors**: Repeat with referral doctor phone
6. **Type New Number**: Show no alert for unique number

---

## 📞 Quick Test Commands

```bash
# Test backend health
curl http://localhost:3000/health

# Test login
curl -X POST http://localhost:3000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"owner@sobhana.com","password":"password123"}'

# Test search endpoint (replace TOKEN)
curl "http://localhost:3000/api/doctors/search-by-contact?phone=9876543220" \
  -H "Authorization: Bearer YOUR_TOKEN_HERE"
```

---

## ✨ Expected Behavior Summary

**When adding a Referral Doctor:**
- Typing clinic doctor's phone → Yellow alert with link button
- Clicking link → Auto-fill name, show green checkmark
- Typing unique phone → No alert, normal form

**When adding a Clinic Doctor:**
- Typing referral doctor's phone → Yellow alert with link button
- Clicking link → Auto-fill name, show green checkmark
- Typing unique phone → No alert, normal form

**Visual Indicators:**
- 🟡 Yellow alert box = Doctor found in other category
- 🔗 "Link to this doctor" button = Action available
- ✅ Green checkmark = Successfully linked
- 📱 Toast notification = Confirmation message

---

## Need Help?

If the feature still isn't working after following this guide:
1. Share screenshots of browser console
2. Share screenshots of network tab
3. Share backend terminal output
4. Describe exactly what you're seeing vs. what you expect
