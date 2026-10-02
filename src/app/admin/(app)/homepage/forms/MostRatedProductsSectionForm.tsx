'use client';
/** MostRatedProductsSectionForm — Item 18 Phase 2. Alias of
 *  ProductCollectionSectionForm with the source.mode pre-locked. */
import React from 'react';
import type { SectionFormProps } from './types';
import ProductCollectionSectionForm from './ProductCollectionSectionForm';

export default function MostRatedProductsSectionForm(props: SectionFormProps) {
  return <ProductCollectionSectionForm {...props} lockedMode="top_rated" />;
}
