/**
 * E2-10: Test Patient Demographic Validation
 * Tests validation rules for patient input data
 */

import { validatePatientDemographics, validatePhone, validateEmail } from './src/utils/validation';

console.log('🧪 E2-10: Testing Patient Demographic Validation\n');

// Test 1: Valid patient data
console.log('Test 1: Valid patient data');
const validResult = validatePatientDemographics({
  name: 'Ramesh Kumar',
  age: 45,
  gender: 'M',
  identifiers: [
    { type: 'PHONE', value: '9876543210' },
    { type: 'EMAIL', value: 'ramesh@gmail.com' }
  ]
});
console.log(validResult.valid ? '✅ Pass' : '❌ Fail', validResult);

// Test 2: Invalid name (too short)
console.log('\nTest 2: Name too short');
const shortNameResult = validatePatientDemographics({
  name: 'A',
  age: 30,
  gender: 'F'
});
console.log(!shortNameResult.valid && shortNameResult.errors.name ? '✅ Pass' : '❌ Fail');
console.log('Error:', shortNameResult.errors.name);

// Test 3: Invalid name (special characters)
console.log('\nTest 3: Name with invalid characters');
const specialNameResult = validatePatientDemographics({
  name: 'Patient@123',
  age: 30,
  gender: 'M'
});
console.log(!specialNameResult.valid && specialNameResult.errors.name ? '✅ Pass' : '❌ Fail');
console.log('Error:', specialNameResult.errors.name);

// Test 4: Invalid age (negative)
console.log('\nTest 4: Negative age');
const negativeAgeResult = validatePatientDemographics({
  name: 'Test Patient',
  age: -5,
  gender: 'M'
});
console.log(!negativeAgeResult.valid && negativeAgeResult.errors.age ? '✅ Pass' : '❌ Fail');
console.log('Error:', negativeAgeResult.errors.age);

// Test 5: Invalid age (too old)
console.log('\nTest 5: Age exceeds 120');
const oldAgeResult = validatePatientDemographics({
  name: 'Test Patient',
  age: 150,
  gender: 'M'
});
console.log(!oldAgeResult.valid && oldAgeResult.errors.age ? '✅ Pass' : '❌ Fail');
console.log('Error:', oldAgeResult.errors.age);

// Test 6: Invalid gender
console.log('\nTest 6: Invalid gender');
const invalidGenderResult = validatePatientDemographics({
  name: 'Test Patient',
  age: 30,
  gender: 'X' as any
});
console.log(!invalidGenderResult.valid && invalidGenderResult.errors.gender ? '✅ Pass' : '❌ Fail');
console.log('Error:', invalidGenderResult.errors.gender);

// Test 7: Invalid phone (too short)
console.log('\nTest 7: Phone too short');
const shortPhoneError = validatePhone('123');
console.log(shortPhoneError ? '✅ Pass' : '❌ Fail');
console.log('Error:', shortPhoneError);

// Test 8: Invalid phone (wrong starting digit)
console.log('\nTest 8: Phone starts with invalid digit');
const invalidStartError = validatePhone('5123456789');
console.log(invalidStartError ? '✅ Pass' : '❌ Fail');
console.log('Error:', invalidStartError);

// Test 9: Invalid phone (all same digits)
console.log('\nTest 9: Phone all same digits');
const sameDigitsError = validatePhone('9999999999');
console.log(sameDigitsError ? '✅ Pass' : '❌ Fail');
console.log('Error:', sameDigitsError);

// Test 10: Valid phone
console.log('\nTest 10: Valid phone number');
const validPhoneError = validatePhone('9876543210');
console.log(validPhoneError === null ? '✅ Pass' : '❌ Fail');
console.log('Error:', validPhoneError);

// Test 11: Invalid email
console.log('\nTest 11: Invalid email format');
const invalidEmailError = validateEmail('notanemail');
console.log(invalidEmailError ? '✅ Pass' : '❌ Fail');
console.log('Error:', invalidEmailError);

// Test 12: Valid email
console.log('\nTest 12: Valid email');
const validEmailError = validateEmail('patient@example.com');
console.log(validEmailError === null ? '✅ Pass' : '❌ Fail');
console.log('Error:', validEmailError);

// Test 13: Multiple validation errors
console.log('\nTest 13: Multiple validation errors');
const multipleErrors = validatePatientDemographics({
  name: 'X',
  age: -10,
  gender: 'Z' as any,
  identifiers: [
    { type: 'PHONE', value: '123' },
    { type: 'EMAIL', value: 'bademail' }
  ]
});
console.log(!multipleErrors.valid && Object.keys(multipleErrors.errors).length > 3 ? '✅ Pass' : '❌ Fail');
console.log('Errors:', multipleErrors.errors);

console.log('\n✅ All E2-10 validation tests completed!');
